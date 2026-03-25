import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

// ─── Palette Tumulte ───
const COLORS = {
  PRIMARY: 0xc8a87c,
  SUCCESS: 0x57f287,
  WARNING: 0xfee75c,
  ERROR: 0xed4245,
  INFO: 0x5865f2,
  VEILLE: 0xc8a87c,
  SUGGESTION: 0x5865f2,
  PRODUCTION: 0xeb459e,
  PUBLICATION: 0x57f287,
} as const;

export interface MessagePayload {
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

export interface VeilleArticleSummary {
  readonly id: number;
  readonly title: string;
  readonly translatedTitle?: string | undefined;
  readonly suggestedAngle?: string | undefined;
  readonly source: string;
  readonly url: string;
  readonly score: number;
  readonly publishedDate?: string | undefined;
}

export interface VeilleStats {
  readonly totalFetched: number;
  readonly deduplicated: number;
  readonly kept: number;
}

export interface SuggestionData {
  readonly id: number;
  readonly content: string;
  readonly pillar: string;
  readonly platform: string;
  readonly format?: string | undefined;
}

export interface SearchResultData {
  readonly sourceTable: string;
  readonly sourceId: number;
  readonly title: string;
  readonly snippet: string;
}

export interface BudgetPeriodData {
  readonly label: string;
  readonly anthropicCents: number;
  readonly googleCents: number;
  readonly totalCents: number;
  readonly budgetCents: number;
}

export interface PreferenceEntryData {
  readonly dimension: string;
  readonly value: string;
  readonly score: number;
  readonly totalCount: number;
}

function centsToEuros(cents: number): string {
  return (cents / 100).toFixed(2);
}

function progressBar(percent: number, length: number = 16): string {
  const filled = Math.round((percent / 100) * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function scoreLabel(score: number): string {
  if (score >= 0.75) return 'FORTE PRÉFÉRENCE';
  if (score >= 0.4) return 'préférence';
  if (score >= 0.1) return 'légèrement positif';
  if (score > -0.1) return 'neutre';
  if (score > -0.4) return 'légèrement négatif';
  return 'à éviter';
}

// ─── Veille ───

export function veilleDigest(
  topArticles: readonly VeilleArticleSummary[],
  stats: VeilleStats,
  preferenceHighlights?: string,
): MessagePayload {
  const today = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.VEILLE)
    .setTitle(`📜 Veille du ${today}`)
    .setTimestamp();

  if (topArticles.length > 0) {
    const topLines = topArticles.slice(0, 5).map((a) => {
      const title = a.translatedTitle ?? a.title;
      const angle = a.suggestedAngle !== undefined ? `\n  💡 ${a.suggestedAngle}` : '';
      const time = a.publishedDate ?? 'récent';
      return `► **${title}** (${String(a.score)}/10)${angle}\n  ${a.source} — ${time}`;
    });

    embed.addFields({
      name: `🔥 TOP (${String(topArticles.length)} articles — score ≥ 8)`,
      value: topLines.join('\n\n'),
    });
  } else {
    embed.addFields({
      name: '📭 Rien de marquant aujourd\'hui',
      value: 'Aucun article n\'a atteint le score de 8/10.',
    });
  }

  const statsLine = `📊 ${String(stats.totalFetched)} scannés → ${String(stats.kept)} retenus → ${String(topArticles.length)} top`;
  const prefLine = preferenceHighlights ?? '';
  embed.addFields({ name: 'Stats', value: `${statsLine}\n${prefLine}`.trim() });

  return { embeds: [embed], components: [] };
}

export function veilleArticle(article: VeilleArticleSummary): MessagePayload {
  const title = article.translatedTitle ?? article.title;
  const scoreEmoji = article.score >= 8 ? '🔥' : '⚔️';

  const embed = new EmbedBuilder()
    .setColor(COLORS.VEILLE)
    .setTitle(`${scoreEmoji} ${title} (${String(article.score)}/10)`)
    .setURL(article.url)
    .setTimestamp();

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: '📂 Source', value: article.source, inline: true },
  ];

  if (article.suggestedAngle !== undefined) {
    fields.push({ name: '💡 Angle suggéré', value: article.suggestedAngle, inline: false });
  }

  embed.addFields(fields);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`thumbup:veille_articles:${String(article.id)}`)
      .setEmoji('👍')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`thumbdown:veille_articles:${String(article.id)}`)
      .setEmoji('👎')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`transform:veille_articles:${String(article.id)}`)
      .setLabel('Transformer en contenu')
      .setEmoji('🎯')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`archive:veille_articles:${String(article.id)}`)
      .setLabel('Archiver')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Suggestions ───

export function suggestion(data: SuggestionData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.SUGGESTION)
    .setTitle('💡 Suggestion de contenu')
    .setDescription(data.content)
    .addFields(
      { name: '🏷️ Pilier', value: data.pillar, inline: true },
      { name: '📱 Plateforme', value: data.platform, inline: true },
    )
    .setTimestamp();

  if (data.format !== undefined) {
    embed.addFields({ name: '📐 Format', value: data.format, inline: true });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`go:suggestions:${String(data.id)}`)
      .setLabel('Go')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`modify:suggestions:${String(data.id)}`)
      .setLabel('Modifier')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`skip:suggestions:${String(data.id)}`)
      .setLabel('Skip')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`later:suggestions:${String(data.id)}`)
      .setLabel('Plus tard')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Search Results ───

export function searchResults(
  results: readonly SearchResultData[],
  query: string,
  page: number,
  total: number,
): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`🔍 Recherche : "${query}"`)
    .setDescription(`${String(total)} résultats trouvés`)
    .setTimestamp();

  if (results.length === 0) {
    embed.setDescription('Aucun résultat trouvé.');
    return { embeds: [embed], components: [] };
  }

  const grouped: Record<string, SearchResultData[]> = {};
  for (const r of results) {
    const table = grouped[r.sourceTable];
    if (table === undefined) {
      grouped[r.sourceTable] = [r];
    } else {
      table.push(r);
    }
  }

  const tableLabels: Record<string, string> = {
    veille_articles: '📰 Veille',
    suggestions: '💡 Suggestions',
    publications: '📤 Publications',
  };

  for (const [table, items] of Object.entries(grouped)) {
    const label = tableLabels[table] ?? table;
    const lines = items
      .slice(0, 5)
      .map((r) => `► ${r.title}\n  ${r.snippet.slice(0, 100)}...`);

    embed.addFields({ name: `${label} (${String(items.length)})`, value: lines.join('\n') });
  }

  const totalPages = Math.ceil(total / 10);
  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (totalPages > 1) {
    const row = new ActionRowBuilder<ButtonBuilder>();

    if (page > 1) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`page:search:${String(page - 1)}`)
          .setLabel('◀️ Précédent')
          .setStyle(ButtonStyle.Secondary),
      );
    }

    if (page < totalPages) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`page:search:${String(page + 1)}`)
          .setLabel('▶️ Suivant')
          .setStyle(ButtonStyle.Secondary),
      );
    }

    components.push(row);
  }

  embed.setFooter({ text: `Page ${String(page)}/${String(totalPages)}` });

  return { embeds: [embed], components };
}

// ─── Budget ───

export function budgetReport(periods: readonly BudgetPeriodData[]): MessagePayload {
  const today = new Date().toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle(`💰 Budget — ${today}`)
    .setTimestamp();

  for (const period of periods) {
    const percent = period.budgetCents > 0
      ? Math.round((period.totalCents / period.budgetCents) * 100)
      : 0;

    const bar = progressBar(percent);

    embed.addFields({
      name: `📅 ${period.label}`,
      value: [
        `Anthropic : ${centsToEuros(period.anthropicCents)}€`,
        `Google AI : ${centsToEuros(period.googleCents)}€`,
        `**Total : ${centsToEuros(period.totalCents)}€ / ${centsToEuros(period.budgetCents)}€ (${String(percent)}%)**`,
        bar,
      ].join('\n'),
    });
  }

  return { embeds: [embed], components: [] };
}

export function budgetAlert(
  period: string,
  percent: number,
  costCents: number,
  budgetCents: number,
): MessagePayload {
  const emoji = percent >= 100 ? '⛔' : '⚠️';
  const color = percent >= 100 ? COLORS.ERROR : COLORS.WARNING;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} Alerte budget — Seuil ${String(percent)}%`)
    .addFields(
      { name: '📅 Période', value: period, inline: true },
      {
        name: '💰 Dépensé',
        value: `${centsToEuros(costCents)}€ / ${centsToEuros(budgetCents)}€`,
        inline: true,
      },
    )
    .setDescription(progressBar(percent))
    .setTimestamp();

  if (percent >= 100) {
    embed.addFields({
      name: '⚡ Action',
      value: 'API payantes suspendues. SearXNG + Discord continuent.',
    });
  }

  return { embeds: [embed], components: [] };
}

// ─── Preference Profile ───

export function preferenceProfile(entries: readonly PreferenceEntryData[]): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle('📊 Profil de préférences')
    .setTimestamp();

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

    if (dimEntries.length === 0) {
      continue;
    }

    const lines = dimEntries.map((e) => {
      const sign = e.score >= 0 ? '+' : '';
      return `${e.value}: ${sign}${e.score.toFixed(2)} (${String(e.totalCount)}) — ${scoreLabel(e.score)}`;
    });

    const label = dimensionLabels[dim] ?? dim;
    embed.addFields({ name: label, value: lines.join('\n') });
  }

  if (entries.length === 0) {
    embed.setDescription('Aucune donnée de feedback encore. Note des articles avec 👍/👎 pour alimenter le profil.');
  }

  return { embeds: [embed], components: [] };
}

// ─── Utility ───

export function errorMessage(message: string): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.ERROR)
    .setTitle('❌ Erreur')
    .setDescription(message)
    .setTimestamp();

  return { embeds: [embed], components: [] };
}

export function successMessage(message: string): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.SUCCESS)
    .setTitle('✅ Succès')
    .setDescription(message)
    .setTimestamp();

  return { embeds: [embed], components: [] };
}

export function infoMessage(message: string): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setDescription(message)
    .setTimestamp();

  return { embeds: [embed], components: [] };
}
