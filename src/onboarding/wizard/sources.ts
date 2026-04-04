import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder as ModalActionRow,
} from 'discord.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession, getStepLabel } from './state-machine.js';
import { complete } from '../../services/anthropic.js';
import { getLogger } from '../../core/logger.js';
import { collectFromRss } from '../../veille/sources/rss.js';

// ─── Source definitions ───

interface SourceDef {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly description: string;
  readonly alwaysOn: boolean;
  readonly hasConfig: boolean;
  readonly warningText?: string;
}

const SOURCES: readonly SourceDef[] = [
  { id: 'searxng', label: 'SearXNG', emoji: '🔍', description: 'Meta-search web (toujours actif)', alwaysOn: true, hasConfig: false },
  { id: 'rss', label: 'RSS / Atom', emoji: '📰', description: 'Blogs et médias spécialisés', alwaysOn: false, hasConfig: true },
  { id: 'reddit', label: 'Reddit', emoji: '🤖', description: 'Subreddits ciblés (API native /hot + /rising)', alwaysOn: false, hasConfig: true },
  { id: 'youtube', label: 'YouTube', emoji: '📺', description: 'YouTube Data API + transcriptions auto', alwaysOn: false, hasConfig: true },
  { id: 'web_search', label: 'LLM Web Search', emoji: '🧠', description: 'Recherche IA contextuelle profonde', alwaysOn: false, hasConfig: false, warningText: '⚠️ Consomme des tokens LLM supplémentaires' },
];

// ─── Build sources selection UI ───

export function buildSourcesSelection(session: WizardSession): V2MessagePayload {
  const enabled = new Set(session.data.enabledSources ?? ['searxng']);

  const statusLines = SOURCES.map((s) => {
    const isOn = s.alwaysOn || enabled.has(s.id);
    const status = isOn ? '✅' : '❌';
    const warning = s.warningText !== undefined && isOn ? ` — ${s.warningText}` : '';
    return `${status} ${s.emoji} **${s.label}** — ${s.description}${warning}`;
  });

  const sourceButtons = SOURCES.filter((s) => !s.alwaysOn).map((s) => {
    const isOn = enabled.has(s.id);
    return btn(
      `wizard:source:toggle:${s.id}`,
      s.label,
      isOn ? ButtonStyle.Success : ButtonStyle.Secondary,
      s.emoji,
    );
  });

  // Split buttons in rows of 4
  const buttonRows: ReturnType<typeof row>[] = [];
  for (let i = 0; i < sourceButtons.length; i += 4) {
    buttonRows.push(row(...sourceButtons.slice(i, i + 4)));
  }

  // Config buttons for sources that have settings
  const configButtons = SOURCES
    .filter((s) => s.hasConfig && enabled.has(s.id))
    .map((s) => btn(`wizard:source:config:${s.id}`, `⚙️ ${s.label}`, ButtonStyle.Primary));

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 📡 Sources de veille — Étape ${getStepLabel(session.step)}`,
      '',
      'Configure les sources de données pour ta veille.',
      'SearXNG est toujours actif. Active les sources supplémentaires.',
      '',
      statusLines.join('\n'),
    ].join('\n')));
    c.addSeparatorComponents(sep());
    for (const r of buttonRows) {
      c.addActionRowComponents(r);
    }
    if (configButtons.length > 0) {
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(...configButtons));
    }
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider les sources', ButtonStyle.Success, '✅'),
      btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}

// ─── Toggle source ───

export function toggleSource(session: WizardSession, sourceId: string): void {
  const current = new Set(session.data.enabledSources ?? ['searxng']);

  if (current.has(sourceId)) {
    current.delete(sourceId);
  } else {
    current.add(sourceId);
  }

  // SearXNG always stays on
  current.add('searxng');
  session.data.enabledSources = [...current];
}

// ─── Config modals ───

export function buildRssConfigModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:source:rss')
    .setTitle('Flux RSS / Atom')
    .addComponents(
      new ModalActionRow<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('rss_urls')
          .setLabel('URLs des flux (un par ligne)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('https://blog.example.com/rss\nhttps://news.example.com/feed'),
      ),
    );
}

export function buildRedditConfigModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:source:reddit')
    .setTitle('Subreddits à surveiller')
    .addComponents(
      new ModalActionRow<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('subreddits')
          .setLabel('Subreddits (un par ligne, sans r/)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('rpg\ndndnext\nFoundryVTT'),
      ),
    );
}

export function buildYouTubeConfigModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:source:youtube')
    .setTitle('YouTube — Mots-clés de recherche')
    .addComponents(
      new ModalActionRow<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('youtube_keywords')
          .setLabel('Mots-clés (un par ligne)')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('D&D news\nTTRPG review\nJDR streaming'),
      ),
    );
}

// ─── Auto-populate sources via LLM ───

interface LlmSourceSuggestions {
  rss: string[];
  subreddits: string[];
  youtubeKeywords: string[];
}

/**
 * Calls the LLM to generate default sources (RSS feeds, subreddits, YouTube keywords)
 * based on the project niche. Populates empty source configs automatically.
 */
async function autoPopulateSources(session: WizardSession): Promise<void> {
  const logger = getLogger();
  const enabled = new Set(session.data.enabledSources ?? ['searxng']);
  const niche = session.data.projectNiche ?? session.data.projectDescription ?? '';
  const name = session.data.projectName ?? '';

  // Check which sources need auto-population
  const needsRss = enabled.has('rss') && (session.data.rssUrls ?? []).length === 0;
  const needsReddit = enabled.has('reddit') && (session.data.redditSubreddits ?? []).length === 0;
  const needsYoutube = enabled.has('youtube') && (session.data.youtubeKeywords ?? []).length === 0;

  if (!needsRss && !needsReddit && !needsYoutube) return;

  const requestParts: string[] = [];
  if (needsRss) requestParts.push('- "rss": 5-10 URLs de flux RSS/Atom pertinents (blogs, médias, sites spécialisés)');
  if (needsReddit) requestParts.push('- "subreddits": 5-8 noms de subreddits pertinents (sans r/)');
  if (needsYoutube) requestParts.push('- "youtubeKeywords": 8-12 mots-clés de recherche YouTube (mix FR et EN)');

  const systemPrompt = [
    'Tu es un expert en veille et stratégie de contenu.',
    'L\'utilisateur a un projet dans une niche spécifique.',
    'Génère des sources de veille pertinentes pour maximiser la couverture.',
    'Inclus des sources en FRANÇAIS et en ANGLAIS.',
    '',
    'Retourne UNIQUEMENT du JSON valide, sans explication :',
    `{${requestParts.map((p) => p.split('"')[1]).join(', ')}}`,
  ].join('\n');

  const userMessage = [
    `Projet : ${name}`,
    `Niche : ${niche}`,
    `Langue principale : ${session.data.projectLanguage ?? 'fr'}`,
    '',
    'Génère les sources suivantes :',
    ...requestParts,
    '',
    'Pour les RSS : privilégie des blogs actifs et des médias reconnus dans la niche.',
    'Pour les subreddits : inclus les gros subs généralistes ET les subs de niche.',
    'Pour YouTube : mélange mots-clés FR et EN pour couvrir les deux marchés.',
  ].join('\n');

  try {
    const response = await complete(systemPrompt, userMessage, {
      maxTokens: 1024,
      temperature: 0.5,
    });

    let jsonText = response.text.trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7);
    if (jsonText.startsWith('```')) jsonText = jsonText.slice(3);
    if (jsonText.endsWith('```')) jsonText = jsonText.slice(0, -3);
    jsonText = jsonText.trim();

    const suggestions = JSON.parse(jsonText) as Partial<LlmSourceSuggestions>;

    if (needsRss && Array.isArray(suggestions.rss) && suggestions.rss.length > 0) {
      session.data.rssUrls = suggestions.rss.filter((u): u is string => typeof u === 'string' && u.startsWith('http'));
      logger.info({ count: session.data.rssUrls.length }, 'Auto-populated RSS feeds');
    }

    if (needsReddit && Array.isArray(suggestions.subreddits) && suggestions.subreddits.length > 0) {
      session.data.redditSubreddits = suggestions.subreddits
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.replace(/^r\//, ''));
      logger.info({ count: session.data.redditSubreddits.length }, 'Auto-populated subreddits');
    }

    if (needsYoutube && Array.isArray(suggestions.youtubeKeywords) && suggestions.youtubeKeywords.length > 0) {
      session.data.youtubeKeywords = suggestions.youtubeKeywords.filter((k): k is string => typeof k === 'string');
      logger.info({ count: session.data.youtubeKeywords.length }, 'Auto-populated YouTube keywords');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Failed to auto-populate sources via LLM');
  }
}

// ─── Mini dry-run for new sources ───

export async function miniDryRunSources(session: WizardSession): Promise<V2MessagePayload> {
  const logger = getLogger();
  const enabled = new Set(session.data.enabledSources ?? ['searxng']);

  // Auto-populate empty sources via LLM before testing
  await autoPopulateSources(session);

  const results: Array<{ source: string; emoji: string; resultCount: number; samples: string[] }> = [];

  // Test RSS feeds
  if (enabled.has('rss') && (session.data.rssUrls ?? []).length > 0) {
    try {
      const articles = await collectFromRss({ urls: session.data.rssUrls });
      results.push({
        source: 'RSS / Atom',
        emoji: '📰',
        resultCount: articles.length,
        samples: articles.slice(0, 3).map((a) => `► ${a.title.slice(0, 60)}`),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ error: msg }, 'Mini dry-run RSS failed');
      results.push({ source: 'RSS / Atom', emoji: '📰', resultCount: 0, samples: ['(erreur)'] });
    }
  }

  // Test Reddit via native API
  if (enabled.has('reddit') && (session.data.redditSubreddits ?? []).length > 0) {
    const subs = session.data.redditSubreddits ?? [];
    const firstSub = subs[0];
    if (firstSub !== undefined) {
      try {
        const response = await fetch(
          `https://old.reddit.com/r/${encodeURIComponent(firstSub)}/hot.json?limit=5&raw_json=1`,
          {
            headers: { 'User-Agent': 'LeChroniqueur/1.0 (veille bot; +https://github.com)' },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.ok) {
          const listing = await response.json() as { data: { children: Array<{ data: { title: string } }> } };
          const posts = listing.data.children;
          results.push({
            source: `Reddit (r/${firstSub})`,
            emoji: '🤖',
            resultCount: posts.length,
            samples: posts.slice(0, 3).map((p) => `► ${p.data.title.slice(0, 60)}`),
          });
        } else {
          results.push({ source: 'Reddit', emoji: '🤖', resultCount: 0, samples: [`(HTTP ${String(response.status)})`] });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ error: msg }, 'Mini dry-run Reddit failed');
        results.push({ source: 'Reddit', emoji: '🤖', resultCount: 0, samples: ['(erreur)'] });
      }
    }
  }

  // Test YouTube via Data API v3
  if (enabled.has('youtube') && (session.data.youtubeKeywords ?? []).length > 0) {
    const firstKw = (session.data.youtubeKeywords ?? [])[0];
    const apiKey = process.env['GOOGLE_CLOUD_API_KEY'];
    if (firstKw !== undefined && apiKey !== undefined && apiKey.length > 0) {
      try {
        const params = new URLSearchParams({
          part: 'snippet', q: firstKw, type: 'video', order: 'date',
          maxResults: '5', relevanceLanguage: 'en', key: apiKey,
        });
        const response = await fetch(
          `https://www.googleapis.com/youtube/v3/search?${params.toString()}`,
          { signal: AbortSignal.timeout(15_000) },
        );
        if (response.ok) {
          const data = await response.json() as { items: Array<{ snippet: { title: string } }> };
          results.push({
            source: 'YouTube',
            emoji: '📺',
            resultCount: data.items.length,
            samples: data.items.slice(0, 3).map((i) => `► ${i.snippet.title.slice(0, 60)}`),
          });
        } else if (response.status === 403) {
          results.push({ source: 'YouTube', emoji: '📺', resultCount: 0, samples: ['⚠️ API YouTube Data non activée sur ton projet Google Cloud'] });
        } else {
          results.push({ source: 'YouTube', emoji: '📺', resultCount: 0, samples: [`(HTTP ${String(response.status)})`] });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ error: msg }, 'Mini dry-run YouTube failed');
        results.push({ source: 'YouTube', emoji: '📺', resultCount: 0, samples: ['(erreur)'] });
      }
    } else if (apiKey === undefined || apiKey.length === 0) {
      results.push({ source: 'YouTube', emoji: '📺', resultCount: 0, samples: ['⚠️ Clé Google Cloud non configurée'] });
    }
  }

  // Build auto-populated summary
  const autoPopulated: string[] = [];
  if ((session.data.rssUrls ?? []).length > 0) {
    autoPopulated.push(`📰 **${String((session.data.rssUrls ?? []).length)} flux RSS** : ${(session.data.rssUrls ?? []).slice(0, 3).map((u) => { try { return new URL(u).hostname; } catch { return u; } }).join(', ')}${(session.data.rssUrls ?? []).length > 3 ? '...' : ''}`);
  }
  if ((session.data.redditSubreddits ?? []).length > 0) {
    autoPopulated.push(`🤖 **${String((session.data.redditSubreddits ?? []).length)} subreddits** : ${(session.data.redditSubreddits ?? []).map((s) => `r/${s}`).join(', ')}`);
  }
  if ((session.data.youtubeKeywords ?? []).length > 0) {
    autoPopulated.push(`📺 **${String((session.data.youtubeKeywords ?? []).length)} keywords YouTube** : ${(session.data.youtubeKeywords ?? []).slice(0, 5).join(', ')}${(session.data.youtubeKeywords ?? []).length > 5 ? '...' : ''}`);
  }

  // No sources at all
  if (results.length === 0 && autoPopulated.length === 0) {
    return v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        `## 🔍 Mini dry-run — Étape ${getStepLabel(session.step)}`,
        '',
        'Aucune source supplémentaire activée (SearXNG uniquement).',
        'Tu pourras en ajouter plus tard via le dashboard.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:next', 'Continuer', ButtonStyle.Success, '✅'),
        btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
      ));
    })]);
  }

  const testLines = results.map((r) => {
    const statusEmoji = r.resultCount > 0 ? '✅' : '⚠️';
    const samplesText = r.samples.join('\n');
    return `${statusEmoji} ${r.emoji} **${r.source}** — ${String(r.resultCount)} résultats\n${samplesText}`;
  }).join('\n\n');

  const headerLines = [
    `## 🔍 Mini dry-run — Étape ${getStepLabel(session.step)}`,
    '',
  ];

  if (autoPopulated.length > 0) {
    headerLines.push('**🤖 Sources auto-générées selon ta niche :**', ...autoPopulated, '');
  }

  if (testLines.length > 0) {
    headerLines.push('**📊 Résultats des tests :**', '', testLines);
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt(headerLines.join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Continuer', ButtonStyle.Success, '✅'),
      btn('wizard:redo', 'Retester', ButtonStyle.Secondary, '🔄'),
      btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}
