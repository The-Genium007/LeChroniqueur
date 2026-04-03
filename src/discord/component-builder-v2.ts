import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  ThumbnailBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';

// ─── Types ───

/**
 * V2 message payload. Use with channel.send() or interaction.reply().
 * The `components` array contains serialized V2 components (via toJSON).
 * The `flags` field includes IsComponentsV2.
 */
export interface V2MessagePayload {
  readonly components: ReturnType<ContainerBuilder['toJSON']>[];
  readonly flags: number;
}

// ─── Theme ───

const DEFAULT_THEME = {
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
  info: 0x5865f2,
  veille: 0x5865f2,
  suggestion: 0x5865f2,
  production: 0xeb459e,
  publication: 0x57f287,
} as const;

type ThemeColor = keyof typeof DEFAULT_THEME;

function getColor(color: ThemeColor, theme?: Partial<typeof DEFAULT_THEME>): number {
  return theme?.[color] ?? DEFAULT_THEME[color];
}

// ─── Low-level helpers ───

function txt(content: string): TextDisplayBuilder {
  return new TextDisplayBuilder().setContent(content);
}

function sep(spacing: 'small' | 'large' = 'small'): SeparatorBuilder {
  return new SeparatorBuilder()
    .setSpacing(spacing === 'small' ? SeparatorSpacingSize.Small : SeparatorSpacingSize.Large)
    .setDivider(true);
}

function btn(customId: string, label: string, style: ButtonStyle = ButtonStyle.Secondary, emoji?: string): ButtonBuilder {
  const b = new ButtonBuilder().setCustomId(customId).setStyle(style);
  if (label.length > 0) {
    b.setLabel(label);
  }
  if (emoji !== undefined) {
    b.setEmoji(emoji);
  }
  return b;
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

/**
 * Build a V2 Container and serialize it. Accepts a builder callback for composing children.
 */
function buildContainer(color: number, build: (c: ContainerBuilder) => void): ReturnType<ContainerBuilder['toJSON']> {
  const c = new ContainerBuilder().setAccentColor(color);
  build(c);
  return c.toJSON();
}

function v2(containers: ReturnType<ContainerBuilder['toJSON']>[]): V2MessagePayload {
  return { components: containers, flags: MessageFlags.IsComponentsV2 };
}

// ─── Utility messages ───

export function errorMessage(message: string, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('error', theme), (c) => {
    c.addTextDisplayComponents(txt(`## ❌ Erreur\n${message}`));
  })]);
}

export function successMessage(message: string, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('success', theme), (c) => {
    c.addTextDisplayComponents(txt(`## ✅ Succès\n${message}`));
  })]);
}

export function infoMessage(message: string, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('info', theme), (c) => {
    c.addTextDisplayComponents(txt(message));
  })]);
}

// ─── API Error Messages ───

export function apiErrorMessage(error: Error, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  const name = error.name;
  const provider = (error as { provider?: string }).provider;
  const label = provider === 'anthropic' ? 'Anthropic (Claude)' : 'Google AI (Imagen/Veo)';
  const billingUrl = provider === 'anthropic'
    ? '[console.anthropic.com](https://console.anthropic.com/settings/billing)'
    : '[console.cloud.google.com](https://console.cloud.google.com/billing)';

  if (name === 'ApiQuotaExhaustedError') {
    return v2([buildContainer(getColor('error', theme), (c) => {
      c.addTextDisplayComponents(txt([
        `## 💸 Quota ${label} épuisé`,
        '',
        'Les crédits API sont insuffisants pour cette opération.',
        '',
        `**Action :** Vérifie ton solde sur ${billingUrl}`,
      ].join('\n')));
    })]);
  }

  if (name === 'ApiAuthError') {
    return v2([buildContainer(getColor('error', theme), (c) => {
      c.addTextDisplayComponents(txt([
        `## 🔑 Clé ${label} invalide`,
        '',
        'La clé API a été refusée par le serveur.',
        '',
        '**Action :** Mets à jour ta clé via le dashboard (Config > Clés API).',
      ].join('\n')));
    })]);
  }

  if (name === 'ApiNotConfiguredError') {
    return v2([buildContainer(getColor('warning', theme), (c) => {
      c.addTextDisplayComponents(txt([
        `## ⚠️ ${label} non configuré`,
        '',
        'Aucune clé API n\'est enregistrée pour ce service.',
        '',
        '**Action :** Configure ta clé via le dashboard (Config > Clés API).',
      ].join('\n')));
    })]);
  }

  if (name === 'ApiOverloadedError') {
    return v2([buildContainer(getColor('warning', theme), (c) => {
      c.addTextDisplayComponents(txt([
        `## ⏳ ${label} surchargé`,
        '',
        'Le service est temporairement indisponible. Réessaie dans quelques minutes.',
      ].join('\n')));
    })]);
  }

  // Fallback — generic error
  return errorMessage(error.message, theme);
}

// ─── Veille ───

export interface V2VeilleArticle {
  readonly id: number;
  readonly title: string;
  readonly translatedTitle?: string | undefined;
  readonly suggestedAngle?: string | undefined;
  readonly source: string;
  readonly url: string;
  readonly score: number;
  readonly thumbnailUrl?: string | undefined;
}

export interface V2VeilleStats {
  readonly totalFetched: number;
  readonly deduplicated: number;
  readonly kept: number;
}

export function veilleDigest(
  topArticles: readonly V2VeilleArticle[],
  stats: V2VeilleStats,
  preferenceHighlights?: string,
  theme?: Partial<typeof DEFAULT_THEME>,
): V2MessagePayload {
  const today = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return v2([buildContainer(getColor('veille', theme), (c) => {
    c.addTextDisplayComponents(txt(`# 📜 Veille du ${today}`));
    c.addSeparatorComponents(sep());

    if (topArticles.length > 0) {
      const lines = topArticles.slice(0, 5).map((a) => {
        const title = a.translatedTitle ?? a.title;
        const angle = a.suggestedAngle !== undefined ? `\n> 💡 ${a.suggestedAngle}` : '';
        return `**${title}** (${String(a.score)}/10)${angle}\n${a.source}`;
      });
      c.addTextDisplayComponents(txt(`### 🔥 TOP (${String(topArticles.length)} articles — score ≥ 8)\n${lines.join('\n\n')}`));
    } else {
      c.addTextDisplayComponents(txt('### 📭 Rien de marquant aujourd\'hui\nAucun article n\'a atteint le score de 8/10.'));
    }

    c.addSeparatorComponents(sep());

    let statsLine = `📊 ${String(stats.totalFetched)} scannés → ${String(stats.kept)} retenus → ${String(topArticles.length)} top`;
    if (preferenceHighlights !== undefined && preferenceHighlights.length > 0) {
      statsLine += `\n${preferenceHighlights}`;
    }
    c.addTextDisplayComponents(txt(statsLine));
  })]);
}

export function veilleArticle(article: V2VeilleArticle, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  const title = article.translatedTitle ?? article.title;
  const scoreEmoji = article.score >= 8 ? '🔥' : '⚔️';

  return v2([buildContainer(getColor('veille', theme), (c) => {
    c.addTextDisplayComponents(txt(`### ${scoreEmoji} [${title}](${article.url}) (${String(article.score)}/10)\n📂 ${article.source}`));

    if (article.suggestedAngle !== undefined) {
      c.addTextDisplayComponents(txt(`> 💡 ${article.suggestedAngle}`));
    }

    c.addSeparatorComponents(sep());

    c.addActionRowComponents(row(
      btn(`thumbup:veille_articles:${String(article.id)}`, '', ButtonStyle.Secondary, '👍'),
      btn(`thumbdown:veille_articles:${String(article.id)}`, '', ButtonStyle.Secondary, '👎'),
      btn(`transform:veille_articles:${String(article.id)}`, 'Deep dive', ButtonStyle.Success, '🎯'),
      btn(`archive:veille_articles:${String(article.id)}`, 'Archiver', ButtonStyle.Secondary, '⏭️'),
    ));
  })]);
}

// ─── Suggestions ───

export interface V2SuggestionData {
  readonly id: number;
  readonly content: string;
  readonly pillar: string;
  readonly platform: string;
  readonly format?: string | undefined;
}

export function suggestion(data: V2SuggestionData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('suggestion', theme), (c) => {
    c.addTextDisplayComponents(txt('## 💡 Suggestion de contenu'));
    c.addTextDisplayComponents(txt(data.content));
    c.addTextDisplayComponents(txt(
      `🏷️ **Pilier** : ${data.pillar}  ·  📱 **Plateforme** : ${data.platform}${data.format !== undefined ? `  ·  📐 **Format** : ${data.format}` : ''}`,
    ));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`go:suggestions:${String(data.id)}`, 'Go', ButtonStyle.Success, '✅'),
      btn(`modify:suggestions:${String(data.id)}`, 'Modifier', ButtonStyle.Primary, '✏️'),
      btn(`skip:suggestions:${String(data.id)}`, 'Skip', ButtonStyle.Secondary, '⏭️'),
      btn(`later:suggestions:${String(data.id)}`, 'Plus tard', ButtonStyle.Secondary, '⏰'),
    ));
  })]);
}

// ─── Production (script final) ───

export interface V2ProductionData {
  readonly id: number;
  readonly textOverlay: string;
  readonly fullScript: string;
  readonly hashtags: string;
  readonly platform: string;
  readonly suggestedTime: string;
  readonly notes: string;
}

export function production(data: V2ProductionData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('production', theme), (c) => {
    c.addTextDisplayComponents(txt('## 🎬 Script final — prêt à produire'));
    c.addTextDisplayComponents(txt(`**📝 Texte overlay**\n${data.textOverlay || '(vide)'}`));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(`**🎥 Script complet**\n${data.fullScript || '(vide)'}`));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(`🏷️ ${data.hashtags || '(aucun)'}  ·  📱 ${data.platform}  ·  ⏰ ${data.suggestedTime || 'non définie'}`));

    if (data.notes.length > 0) {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt(`**📋 Notes de production**\n${data.notes}`));
    }

    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`validate:productions:${String(data.id)}`, 'Valider', ButtonStyle.Success, '✅'),
      btn(`retouch:productions:${String(data.id)}`, 'Retoucher', ButtonStyle.Primary, '✏️'),
    ));
  })]);
}

// ─── Publication (kit copier-coller) ───

export interface V2PublicationKit {
  readonly id: number;
  readonly platform: string;
  readonly suggestedTime: string;
  readonly caption: string;
  readonly hashtags: string;
  readonly notes: string;
}

export function publicationKit(data: V2PublicationKit, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('publication', theme), (c) => {
    c.addTextDisplayComponents(txt(`## 📤 Prêt à publier\n**${data.platform}** · ${data.suggestedTime}`));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(`**📝 Caption (à copier)**\n\`\`\`\n${data.caption}\n\n${data.hashtags}\n\`\`\``));

    if (data.notes.length > 0) {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt(`**📋 Notes de production**\n${data.notes}`));
    }

    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`pub:copy:${String(data.id)}`, 'Copier caption', ButtonStyle.Primary, '📋'),
      btn(`pub:download:${String(data.id)}`, 'Télécharger tout', ButtonStyle.Secondary, '📥'),
    ));
    c.addActionRowComponents(row(
      btn(`pub:done:${String(data.id)}`, 'Marqué comme publié', ButtonStyle.Success, '✅'),
      btn(`pub:postpone:${String(data.id)}`, 'Reporter', ButtonStyle.Secondary, '📅'),
    ));
  })]);
}

// ─── Deep Dive Result ───

export interface V2DeepDiveData {
  readonly articleTitle: string;
  readonly analysis: string;
  readonly contentSuggestions: readonly string[];
  readonly articleId: number;
}

export function deepDiveResult(data: V2DeepDiveData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('veille', theme), (c) => {
    c.addTextDisplayComponents(txt(`## 🎯 Deep dive — ${data.articleTitle.slice(0, 80)}`));
    c.addTextDisplayComponents(txt(`**📊 Analyse**\n${data.analysis || '(aucune)'}`));
    c.addSeparatorComponents(sep());

    data.contentSuggestions.forEach((s, i) => {
      c.addTextDisplayComponents(txt(`**💡 Suggestion ${String(i + 1)}**\n${s}`));
    });

    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`transform_accept:veille_articles:${String(data.articleId)}`, 'Créer une suggestion', ButtonStyle.Success, '✅'),
      btn(`archive:veille_articles:${String(data.articleId)}`, 'Archiver', ButtonStyle.Secondary, '⏭️'),
    ));
  })]);
}

// ─── Budget Report ───

export interface V2BudgetPeriodData {
  readonly label: string;
  readonly anthropicCents: number;
  readonly googleCents: number;
  readonly totalCents: number;
  readonly budgetCents: number;
}

function centsToEuros(cents: number): string {
  return (cents / 100).toFixed(2);
}

function progressBar(percent: number, length: number = 16): string {
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

export function budgetReport(periods: readonly V2BudgetPeriodData[], theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  const today = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  return v2([buildContainer(getColor('primary', theme), (c) => {
    c.addTextDisplayComponents(txt(`# 💰 Budget — ${today}`));
    c.addSeparatorComponents(sep());

    for (const period of periods) {
      const percent = period.budgetCents > 0
        ? Math.round((period.totalCents / period.budgetCents) * 100)
        : 0;
      const bar = progressBar(percent);

      c.addTextDisplayComponents(txt([
        `### 📅 ${period.label}`,
        `Anthropic : ${centsToEuros(period.anthropicCents)}€`,
        `Google AI : ${centsToEuros(period.googleCents)}€`,
        `**Total : ${centsToEuros(period.totalCents)}€ / ${centsToEuros(period.budgetCents)}€ (${String(percent)}%)**`,
        bar,
      ].join('\n')));
      c.addSeparatorComponents(sep('small'));
    }
  })]);
}

// ─── Budget Alert ───

export function budgetAlert(
  period: string,
  percent: number,
  costCents: number,
  budgetCents: number,
  theme?: Partial<typeof DEFAULT_THEME>,
): V2MessagePayload {
  const emoji = percent >= 100 ? '⛔' : '⚠️';
  const color = percent >= 100 ? getColor('error', theme) : getColor('warning', theme);

  return v2([buildContainer(color, (c) => {
    c.addTextDisplayComponents(txt(`## ${emoji} Alerte budget — Seuil ${String(percent)}%`));
    c.addTextDisplayComponents(txt(`📅 **Période** : ${period}\n💰 **Dépensé** : ${centsToEuros(costCents)}€ / ${centsToEuros(budgetCents)}€`));
    c.addTextDisplayComponents(txt(progressBar(percent)));

    if (percent >= 100) {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt('⚡ **Action** : API payantes suspendues. SearXNG + Discord continuent.'));
    }
  })]);
}

// ─── Search Results ───

export interface V2SearchResultData {
  readonly sourceTable: string;
  readonly sourceId: number;
  readonly title: string;
  readonly snippet: string;
  readonly status?: string | undefined;
  readonly score?: number | undefined;
  readonly url?: string | undefined;
}

const TABLE_LABELS: Record<string, string> = {
  veille_articles: '📰 Veille',
  suggestions: '💡 Suggestion',
  publications: '📤 Publication',
};

const STATUS_LABELS: Record<string, string> = {
  new: '🆕 Nouveau',
  proposed: '📋 Proposé',
  transformed: '🔄 Transformé',
  archived: '📦 Archivé',
  pending: '⏳ En attente',
  go: '✅ Validé',
  skipped: '⏭️ Skippé',
  later: '⏰ Reporté',
  modified: '✏️ Modifié',
  draft: '📝 Brouillon',
  scheduled: '📅 Programmé',
  published: '✅ Publié',
};

function searchResultCard(
  result: V2SearchResultData,
  theme?: Partial<typeof DEFAULT_THEME>,
): ReturnType<ContainerBuilder['toJSON']> {
  const tableLabel = TABLE_LABELS[result.sourceTable] ?? result.sourceTable;
  const statusLabel = result.status !== undefined ? (STATUS_LABELS[result.status] ?? result.status) : undefined;

  const colorKey: ThemeColor = result.sourceTable === 'veille_articles' ? 'veille'
    : result.sourceTable === 'suggestions' ? 'suggestion'
    : result.sourceTable === 'publications' ? 'publication'
    : 'info';

  return buildContainer(getColor(colorKey, theme), (c) => {
    // Title with link if URL available
    const titleText = result.url !== undefined
      ? `### ${tableLabel} — [${result.title}](${result.url})`
      : `### ${tableLabel} — ${result.title}`;
    c.addTextDisplayComponents(txt(titleText));

    // Meta line: status + score
    const meta: string[] = [];
    if (statusLabel !== undefined) meta.push(statusLabel);
    if (result.score !== undefined) meta.push(`⭐ ${String(result.score)}/10`);
    if (meta.length > 0) {
      c.addTextDisplayComponents(txt(meta.join('  ·  ')));
    }

    // Snippet
    if (result.snippet.length > 0) {
      c.addTextDisplayComponents(txt(`> ${result.snippet.slice(0, 150)}`));
    }

    c.addSeparatorComponents(sep());

    // Contextual buttons based on sourceTable + status
    const id = result.sourceId;
    if (result.sourceTable === 'veille_articles') {
      const buttons: ButtonBuilder[] = [];
      if (result.status !== 'proposed' && result.status !== 'transformed') {
        buttons.push(btn(`search:suggest:${String(id)}`, 'Suggérer', ButtonStyle.Success, '💡'));
      }
      buttons.push(btn(`transform:veille_articles:${String(id)}`, 'Deep dive', ButtonStyle.Primary, '🎯'));
      if (result.status === 'archived') {
        buttons.push(btn(`search:reactivate:veille_articles:${String(id)}`, 'Réactiver', ButtonStyle.Secondary, '♻️'));
      } else if (result.status !== 'archived') {
        buttons.push(btn(`archive:veille_articles:${String(id)}`, 'Archiver', ButtonStyle.Secondary, '⏭️'));
      }
      c.addActionRowComponents(row(...buttons));
    } else if (result.sourceTable === 'suggestions') {
      const buttons: ButtonBuilder[] = [];
      if (result.status === 'pending' || result.status === 'later' || result.status === 'modified') {
        buttons.push(btn(`go:suggestions:${String(id)}`, 'Go', ButtonStyle.Success, '✅'));
        buttons.push(btn(`modify:suggestions:${String(id)}`, 'Modifier', ButtonStyle.Primary, '✏️'));
        buttons.push(btn(`skip:suggestions:${String(id)}`, 'Skip', ButtonStyle.Secondary, '⏭️'));
      } else if (result.status === 'skipped') {
        buttons.push(btn(`search:reactivate:suggestions:${String(id)}`, 'Réactiver', ButtonStyle.Success, '♻️'));
      }
      if (buttons.length > 0) {
        c.addActionRowComponents(row(...buttons));
      }
    } else if (result.sourceTable === 'publications') {
      const buttons: ButtonBuilder[] = [];
      if (result.status === 'draft') {
        buttons.push(btn(`search:reactivate:publications:${String(id)}`, 'Reprogrammer', ButtonStyle.Primary, '📅'));
      }
      if (buttons.length > 0) {
        c.addActionRowComponents(row(...buttons));
      }
    }
  });
}

export function searchResults(
  results: readonly V2SearchResultData[],
  query: string,
  page: number,
  total: number,
  theme?: Partial<typeof DEFAULT_THEME>,
): V2MessagePayload {
  const containers: ReturnType<ContainerBuilder['toJSON']>[] = [];

  // Header container
  containers.push(buildContainer(getColor('info', theme), (c) => {
    c.addTextDisplayComponents(txt(`## 🔍 Résultats pour "${query}"\n${String(total)} résultats trouvés`));

    if (results.length === 0) {
      c.addTextDisplayComponents(txt('Aucun résultat trouvé.'));
    }
  }));

  // Individual result cards (max 8 to stay under Discord's 10-container limit)
  for (const r of results.slice(0, 8)) {
    containers.push(searchResultCard(r, theme));
  }

  // Navigation container
  const totalPages = Math.ceil(total / 8);
  containers.push(buildContainer(getColor('info', theme), (c) => {
    const navButtons: ButtonBuilder[] = [];

    if (page > 1) {
      navButtons.push(btn(`search:page:${String(page - 1)}`, 'Précédent', ButtonStyle.Secondary, '◀️'));
    }
    if (page < totalPages) {
      navButtons.push(btn(`search:page:${String(page + 1)}`, 'Suivant', ButtonStyle.Secondary, '▶️'));
    }

    c.addTextDisplayComponents(txt(`Page ${String(page)}/${String(totalPages)}`));

    if (navButtons.length > 0) {
      c.addActionRowComponents(row(...navButtons));
    }

    c.addActionRowComponents(row(
      btn('search:open', 'Nouvelle recherche', ButtonStyle.Primary, '🔍'),
      btn('search:clear', 'Effacer résultats', ButtonStyle.Secondary, '🧹'),
    ));
  }));

  return v2(containers);
}

// ─── Preference Profile ───

export interface V2PreferenceEntry {
  readonly dimension: string;
  readonly value: string;
  readonly score: number;
  readonly totalCount: number;
}

function scoreLabel(score: number): string {
  if (score >= 0.75) return 'FORTE PRÉFÉRENCE';
  if (score >= 0.4) return 'préférence';
  if (score >= 0.1) return 'légèrement positif';
  if (score > -0.1) return 'neutre';
  if (score > -0.4) return 'légèrement négatif';
  return 'à éviter';
}

export function preferenceProfile(entries: readonly V2PreferenceEntry[], theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('info', theme), (c) => {
    c.addTextDisplayComponents(txt('# 📊 Profil de préférences'));
    c.addSeparatorComponents(sep());

    if (entries.length === 0) {
      c.addTextDisplayComponents(txt('Aucune donnée de feedback encore. Note des articles avec 👍/👎 pour alimenter le profil.'));
      return;
    }

    const dimensions = ['source', 'category', 'pillar', 'keyword'];
    const dimensionLabels: Record<string, string> = {
      source: '🔗 Sources',
      category: '📂 Catégories',
      pillar: '🏛️ Piliers',
      keyword: '🔑 Mots-clés',
    };

    for (const dim of dimensions) {
      const dimEntries = entries
        .filter((e) => e.dimension === dim)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);

      if (dimEntries.length === 0) continue;

      const lines = dimEntries.map((e) => {
        const sign = e.score >= 0 ? '+' : '';
        return `${e.value}: ${sign}${e.score.toFixed(2)} (${String(e.totalCount)}) — ${scoreLabel(e.score)}`;
      });

      const label = dimensionLabels[dim] ?? dim;
      c.addTextDisplayComponents(txt(`### ${label}\n${lines.join('\n')}`));
    }
  })]);
}

// ─── Weekly Report ───

export interface V2WeeklyReportData {
  readonly topArticles: readonly { title: string; score: number; source: string; url: string }[];
  readonly articleStats: { collected: number; proposed: number; transformed: number; archived: number };
  readonly suggestionStats: { total: number; goCount: number; skipCount: number; modifiedCount: number };
  readonly feedbackStats: { total: number; positive: number; negative: number };
  readonly publications: readonly { platform: string; content: string; scheduledAt: string | null; views: number | null; likes: number | null }[];
  readonly budget: {
    weekly: { totalCents: number; budgetCents: number; percentUsed: number };
    monthly: { totalCents: number; budgetCents: number; percentUsed: number };
  };
  readonly preferenceHighlights: readonly { dimension: string; value: string; score: number }[];
}

export function weeklyReport(data: V2WeeklyReportData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('primary', theme), (c) => {
    c.addTextDisplayComponents(txt('# 📊 Rapport hebdomadaire'));
    c.addSeparatorComponents(sep());

    if (data.topArticles.length > 0) {
      const lines = data.topArticles.map((a) => `► [${a.title.slice(0, 60)}](${a.url}) (${String(a.score)}/10 — ${a.source})`);
      c.addTextDisplayComponents(txt(`### 🔥 Top articles\n${lines.join('\n')}`));
    }

    const as = data.articleStats;
    c.addTextDisplayComponents(txt(`### 📰 Veille\n${String(as.collected)} collectés | ${String(as.proposed)} proposés | ${String(as.transformed)} transformés | ${String(as.archived)} archivés`));

    const ss = data.suggestionStats;
    const goRate = ss.total > 0 ? Math.round((ss.goCount / ss.total) * 100) : 0;
    c.addTextDisplayComponents(txt(`### 💡 Suggestions\n${String(ss.total)} total | ✅ ${String(ss.goCount)} Go (${String(goRate)}%) | ⏭️ ${String(ss.skipCount)} Skip | ✏️ ${String(ss.modifiedCount)} Modifiées`));

    const fs = data.feedbackStats;
    c.addTextDisplayComponents(txt(`### 👍 Feedback\n${String(fs.total)} ratings | 👍 ${String(fs.positive)} | 👎 ${String(fs.negative)}`));

    if (data.publications.length > 0) {
      const lines = data.publications.map((p) => {
        const metrics = p.views !== null ? ` — ${String(p.views)} vues, ${String(p.likes)} likes` : ' — métriques en attente';
        return `► ${p.platform}: "${p.content.slice(0, 40)}..."${metrics}`;
      });
      c.addTextDisplayComponents(txt(`### 📤 Publications\n${lines.join('\n')}`));
    } else {
      c.addTextDisplayComponents(txt('### 📤 Publications\nAucune cette semaine'));
    }

    const bw = data.budget.weekly;
    const bm = data.budget.monthly;
    c.addTextDisplayComponents(txt(`### 💰 Budget\nSemaine : ${centsToEuros(bw.totalCents)}€ / ${centsToEuros(bw.budgetCents)}€ (${String(bw.percentUsed)}%) ${progressBar(bw.percentUsed, 10)}\nMois : ${centsToEuros(bm.totalCents)}€ / ${centsToEuros(bm.budgetCents)}€ (${String(bm.percentUsed)}%) ${progressBar(bm.percentUsed, 10)}`));

    if (data.preferenceHighlights.length > 0) {
      const lines = data.preferenceHighlights.map((p) => {
        const sign = p.score >= 0 ? '+' : '';
        return `${p.dimension}/${p.value}: ${sign}${p.score.toFixed(2)}`;
      });
      c.addTextDisplayComponents(txt(`### 📈 Préférences\n${lines.join(' | ')}`));
    }
  })]);
}

// ─── Image Gallery V2 ───

export interface V2ImageGalleryData {
  readonly suggestionId: number;
  readonly variants: readonly { index: number; naming: string; url?: string | undefined; dbId?: number | undefined }[];
}

export function imageGallery(data: V2ImageGalleryData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('production', theme), (c) => {
    c.addTextDisplayComponents(txt(`## 🖼️ Variantes générées\n${String(data.variants.length)} variantes pour la suggestion #${String(data.suggestionId)}`));
    c.addSeparatorComponents(sep());

    for (const variant of data.variants) {
      c.addTextDisplayComponents(txt(`**Variante ${String(variant.index + 1)}** — ${variant.naming}`));
    }

    c.addSeparatorComponents(sep());
    const buttons = data.variants.map((v) =>
      btn(`select_image:media:${String(v.dbId ?? 0)}`, `Choisir #${String(v.index + 1)}`, ButtonStyle.Primary),
    );
    if (buttons.length > 0) {
      c.addActionRowComponents(row(...buttons.slice(0, 5)));
    }
  })]);
}

// ─── Video Segment Result V2 ───

export interface V2VideoSegmentResultData {
  readonly naming: string;
  readonly durationSeconds: number;
  readonly postizPath?: string | undefined;
  readonly dbId: number;
}

export function videoSegmentResult(data: V2VideoSegmentResultData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('production', theme), (c) => {
    c.addTextDisplayComponents(txt('## 🎬 Segment vidéo généré'));
    c.addTextDisplayComponents(txt(`📁 **Fichier** : ${data.naming}  ·  ⏱️ **Durée** : ${String(data.durationSeconds)}s`));

    if (data.postizPath !== undefined) {
      c.addTextDisplayComponents(txt(`🔗 [Voir dans Postiz](${data.postizPath})`));
    }
  })]);
}

// ─── Publication Confirmation V2 ───

export interface V2PublicationConfirmationData {
  readonly platform: string;
  readonly scheduledAt: string;
  readonly postizPostId: string;
  readonly content: string;
}

export function publicationConfirmation(data: V2PublicationConfirmationData, theme?: Partial<typeof DEFAULT_THEME>): V2MessagePayload {
  return v2([buildContainer(getColor('publication', theme), (c) => {
    c.addTextDisplayComponents(txt('## 📤 Publication programmée'));
    c.addTextDisplayComponents(txt(
      `📱 **Plateforme** : ${data.platform}  ·  📅 **Date** : ${data.scheduledAt}\n🔗 **Postiz ID** : ${data.postizPostId}`,
    ));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(`**📝 Aperçu**\n${data.content.slice(0, 200)}`));
  })]);
}

// ─── Derivation: Master content card ───

export interface V2MasterContentData {
  readonly treeId: number;
  readonly suggestionId: number;
  readonly masterText: string;
  readonly imageUrl?: string;
}

export function masterContent(data: V2MasterContentData): V2MessagePayload {
  return v2([buildContainer(getColor('production'), (c) => {
    c.addTextDisplayComponents(txt('## 🎯 Contenu Master'));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(data.masterText.slice(0, 3500)));
    if (data.imageUrl !== undefined) {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt(`🖼️ Image master : ${data.imageUrl}`));
    }
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`master:validate:${String(data.treeId)}`, 'Valider master', ButtonStyle.Success, '✅'),
      btn(`master:modify_text:${String(data.treeId)}`, 'Modifier texte', ButtonStyle.Primary, '✏️'),
      btn(`master:regen_image:${String(data.treeId)}`, 'Regénérer image', ButtonStyle.Secondary, '🖼️'),
    ));
  })]);
}

// ─── Derivation: Thread content card ───

export interface V2DerivationThreadData {
  readonly derivationId: number;
  readonly platform: string;
  readonly format: string;
  readonly emoji: string;
  readonly adaptedText: string;
  readonly mediaPrompt?: string;
  readonly status: string;
}

export function derivationThread(data: V2DerivationThreadData): V2MessagePayload {
  return v2([buildContainer(getColor('production'), (c) => {
    c.addTextDisplayComponents(txt(`## ${data.emoji} ${data.platform} — ${data.format}`));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(data.adaptedText.slice(0, 3500)));
    if (data.mediaPrompt !== undefined) {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt(`🎨 **Prompt média** : ${data.mediaPrompt.slice(0, 500)}`));
    }
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`deriv:validate:${String(data.derivationId)}`, 'Valider', ButtonStyle.Success, '✅'),
      btn(`deriv:reject:${String(data.derivationId)}`, 'Refuser', ButtonStyle.Danger, '❌'),
      btn(`deriv:modify:${String(data.derivationId)}`, 'Modifier', ButtonStyle.Primary, '✏️'),
    ));
  })]);
}

// ─── Derivation: Media validation card ───

export interface V2DerivationMediaData {
  readonly derivationId: number;
  readonly platform: string;
  readonly emoji: string;
  readonly mediaUrl: string;
  readonly mediaType: string;
}

export function derivationMedia(data: V2DerivationMediaData): V2MessagePayload {
  return v2([buildContainer(getColor('production'), (c) => {
    c.addTextDisplayComponents(txt(`## ${data.emoji} Média — ${data.platform}`));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(`📎 **Type** : ${data.mediaType}\n🔗 ${data.mediaUrl}`));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`deriv:validate_media:${String(data.derivationId)}`, 'Valider média', ButtonStyle.Success, '✅'),
      btn(`deriv:regen_media:${String(data.derivationId)}`, 'Regénérer', ButtonStyle.Secondary, '🔄'),
    ));
  })]);
}

// ─── Derivation: Publication recap card ───

export interface V2DerivationRecapData {
  readonly treeId: number;
  readonly masterTitle: string;
  readonly derivations: readonly {
    readonly platform: string;
    readonly emoji: string;
    readonly format: string;
    readonly status: string;
    readonly scheduledAt?: string;
  }[];
}

export function derivationRecap(data: V2DerivationRecapData): V2MessagePayload {
  const statusEmoji = (status: string): string => {
    switch (status) {
      case 'ready': return '✅';
      case 'rejected': return '❌';
      case 'scheduled': return '📅';
      case 'published': return '🚀';
      default: return '⏳';
    }
  };

  const lines = data.derivations.map((d) => {
    const schedule = d.scheduledAt !== undefined ? ` — 📅 ${d.scheduledAt}` : '';
    return `${statusEmoji(d.status)} ${d.emoji} **${d.platform}** (${d.format})${schedule}`;
  });

  return v2([buildContainer(getColor('publication'), (c) => {
    c.addTextDisplayComponents(txt(`## 📤 Publication — ${data.masterTitle.slice(0, 80)}`));
    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(lines.join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn(`pub:schedule_all:${String(data.treeId)}`, 'Programmer tout', ButtonStyle.Success, '✅'),
      btn(`pub:modify_schedule:${String(data.treeId)}`, 'Modifier horaires', ButtonStyle.Primary, '📅'),
      btn(`pub:select:${String(data.treeId)}`, 'Sélectionner', ButtonStyle.Secondary, '☑️'),
    ));
  })]);
}

// ─── Analytics report section ───

export interface V2AnalyticsReportData {
  readonly weeklyStats: string;
  readonly slotRecommendations: string;
  readonly treeId?: number;
}

export function analyticsReport(data: V2AnalyticsReportData): V2MessagePayload {
  const containers = [
    buildContainer(getColor('info'), (c) => {
      c.addTextDisplayComponents(txt('## 📊 Analytics & Créneaux'));
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt(data.weeklyStats));
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt(data.slotRecommendations));
    }),
  ];

  return v2(containers);
}

// ─── Export helpers for dashboard pages ───
export {
  txt, sep, btn, row, buildContainer, v2, getColor, progressBar, centsToEuros,
  DEFAULT_THEME,
  type ThemeColor,
  SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
};
