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

// ─── Production (script final) ───

export interface ProductionData {
  readonly id: number;
  readonly textOverlay: string;
  readonly fullScript: string;
  readonly hashtags: string;
  readonly platform: string;
  readonly suggestedTime: string;
  readonly notes: string;
}

export function production(data: ProductionData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRODUCTION)
    .setTitle('🎬 Script final — prêt à produire')
    .addFields(
      { name: '📝 Texte overlay', value: data.textOverlay.slice(0, 1024) || '(vide)' },
      { name: '🎥 Script complet', value: data.fullScript.slice(0, 1024) || '(vide)' },
      { name: '🏷️ Hashtags', value: data.hashtags || '(aucun)', inline: true },
      { name: '📱 Plateforme', value: data.platform, inline: true },
      { name: '⏰ Heure suggérée', value: data.suggestedTime || 'non définie', inline: true },
    )
    .setTimestamp();

  if (data.notes.length > 0) {
    embed.addFields({ name: '📋 Notes de production', value: data.notes.slice(0, 1024) });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`validate:productions:${String(data.id)}`)
      .setLabel('Valider')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`retouch:productions:${String(data.id)}`)
      .setLabel('Retoucher')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Deep Dive ───

export interface DeepDiveData {
  readonly articleTitle: string;
  readonly analysis: string;
  readonly contentSuggestions: readonly string[];
  readonly articleId: number;
}

export function deepDiveResult(data: DeepDiveData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.VEILLE)
    .setTitle(`🎯 Deep dive — ${data.articleTitle.slice(0, 80)}`)
    .addFields(
      { name: '📊 Analyse', value: data.analysis.slice(0, 1024) || '(aucune)' },
    )
    .setTimestamp();

  data.contentSuggestions.forEach((suggestion, i) => {
    embed.addFields({
      name: `💡 Suggestion ${String(i + 1)}`,
      value: suggestion.slice(0, 1024),
    });
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`transform_accept:veille_articles:${String(data.articleId)}`)
      .setLabel('Créer une suggestion')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`archive:veille_articles:${String(data.articleId)}`)
      .setLabel('Archiver')
      .setEmoji('⏭️')
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

// ─── Image Gallery ───

export interface ImageGalleryVariant {
  readonly index: number;
  readonly naming: string;
  readonly postizPath?: string | undefined;
  readonly dbId?: number | undefined;
}

export interface ImageGalleryData {
  readonly suggestionId: number;
  readonly variants: readonly ImageGalleryVariant[];
}

export function imageGallery(data: ImageGalleryData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRODUCTION)
    .setTitle('🖼️ Variantes générées')
    .setDescription(`${String(data.variants.length)} variantes pour la suggestion #${String(data.suggestionId)}`)
    .setTimestamp();

  for (const variant of data.variants) {
    const postizInfo = variant.postizPath !== undefined
      ? `[Voir dans Postiz](${variant.postizPath})`
      : 'Upload Postiz en attente';

    embed.addFields({
      name: `Variante ${String(variant.index + 1)} — ${variant.naming}`,
      value: postizInfo,
    });
  }

  const buttons = data.variants.map((v) =>
    new ButtonBuilder()
      .setCustomId(`select_image:media:${String(v.dbId ?? 0)}`)
      .setLabel(`Choisir #${String(v.index + 1)}`)
      .setStyle(ButtonStyle.Primary),
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

  return { embeds: [embed], components: [row] };
}

// ─── Video Segment Result ───

export interface VideoSegmentResultData {
  readonly naming: string;
  readonly durationSeconds: number;
  readonly postizPath?: string | undefined;
  readonly dbId: number;
}

export function videoSegmentResult(data: VideoSegmentResultData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRODUCTION)
    .setTitle('🎬 Segment vidéo généré')
    .addFields(
      { name: '📁 Fichier', value: data.naming, inline: true },
      { name: '⏱️ Durée', value: `${String(data.durationSeconds)}s`, inline: true },
    )
    .setTimestamp();

  if (data.postizPath !== undefined) {
    embed.addFields({ name: '🔗 Postiz', value: `[Voir](${data.postizPath})` });
  }

  return { embeds: [embed], components: [] };
}

// ─── Publication Confirmation ───

export interface PublicationConfirmationData {
  readonly platform: string;
  readonly scheduledAt: string;
  readonly postizPostId: string;
  readonly content: string;
}

export function publicationConfirmation(data: PublicationConfirmationData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PUBLICATION)
    .setTitle('📤 Publication programmée')
    .addFields(
      { name: '📱 Plateforme', value: data.platform, inline: true },
      { name: '📅 Date', value: data.scheduledAt, inline: true },
      { name: '🔗 Postiz ID', value: data.postizPostId, inline: true },
      { name: '📝 Aperçu', value: data.content.slice(0, 200) },
    )
    .setTimestamp();

  return { embeds: [embed], components: [] };
}

// ─── Weekly Report ───

export interface WeeklyTopArticle {
  readonly title: string;
  readonly score: number;
  readonly source: string;
  readonly url: string;
}

export interface WeeklyPublication {
  readonly platform: string;
  readonly content: string;
  readonly scheduledAt: string | null;
  readonly views: number | null;
  readonly likes: number | null;
}

export interface WeeklyPreferenceHighlight {
  readonly dimension: string;
  readonly value: string;
  readonly score: number;
}

export interface WeeklyReportData {
  readonly topArticles: readonly WeeklyTopArticle[];
  readonly articleStats: {
    readonly collected: number;
    readonly proposed: number;
    readonly transformed: number;
    readonly archived: number;
  };
  readonly suggestionStats: {
    readonly total: number;
    readonly goCount: number;
    readonly skipCount: number;
    readonly modifiedCount: number;
  };
  readonly feedbackStats: {
    readonly total: number;
    readonly positive: number;
    readonly negative: number;
  };
  readonly publications: readonly WeeklyPublication[];
  readonly budget: {
    readonly weekly: { readonly totalCents: number; readonly budgetCents: number; readonly percentUsed: number };
    readonly monthly: { readonly totalCents: number; readonly budgetCents: number; readonly percentUsed: number };
  };
  readonly preferenceHighlights: readonly WeeklyPreferenceHighlight[];
}

export function weeklyReport(data: WeeklyReportData): MessagePayload {
  const embed = new EmbedBuilder()
    .setColor(COLORS.PRIMARY)
    .setTitle('📊 Rapport hebdomadaire')
    .setTimestamp();

  // Top articles
  if (data.topArticles.length > 0) {
    const lines = data.topArticles.map((a) =>
      `► [${a.title.slice(0, 60)}](${a.url}) (${String(a.score)}/10 — ${a.source})`,
    );
    embed.addFields({ name: '🔥 Top articles', value: lines.join('\n') });
  }

  // Article stats
  const as = data.articleStats;
  embed.addFields({
    name: '📰 Veille',
    value: `${String(as.collected)} collectés | ${String(as.proposed)} proposés | ${String(as.transformed)} transformés | ${String(as.archived)} archivés`,
  });

  // Suggestion stats
  const ss = data.suggestionStats;
  const goRate = ss.total > 0 ? Math.round((ss.goCount / ss.total) * 100) : 0;
  embed.addFields({
    name: '💡 Suggestions',
    value: `${String(ss.total)} total | ✅ ${String(ss.goCount)} Go (${String(goRate)}%) | ⏭️ ${String(ss.skipCount)} Skip | ✏️ ${String(ss.modifiedCount)} Modifiées`,
  });

  // Feedback
  const fs = data.feedbackStats;
  embed.addFields({
    name: '👍 Feedback',
    value: `${String(fs.total)} ratings | 👍 ${String(fs.positive)} | 👎 ${String(fs.negative)}`,
    inline: true,
  });

  // Publications
  if (data.publications.length > 0) {
    const lines = data.publications.map((p) => {
      const metrics = p.views !== null ? ` — ${String(p.views)} vues, ${String(p.likes)} likes` : ' — métriques en attente';
      return `► ${p.platform}: "${p.content.slice(0, 40)}..."${metrics}`;
    });
    embed.addFields({ name: '📤 Publications', value: lines.join('\n') });
  } else {
    embed.addFields({ name: '📤 Publications', value: 'Aucune cette semaine' });
  }

  // Budget
  const bw = data.budget.weekly;
  const bm = data.budget.monthly;
  embed.addFields({
    name: '💰 Budget',
    value: [
      `Semaine : ${centsToEuros(bw.totalCents)}€ / ${centsToEuros(bw.budgetCents)}€ (${String(bw.percentUsed)}%) ${progressBar(bw.percentUsed, 10)}`,
      `Mois : ${centsToEuros(bm.totalCents)}€ / ${centsToEuros(bm.budgetCents)}€ (${String(bm.percentUsed)}%) ${progressBar(bm.percentUsed, 10)}`,
    ].join('\n'),
  });

  // Preference highlights
  if (data.preferenceHighlights.length > 0) {
    const lines = data.preferenceHighlights.map((p) => {
      const sign = p.score >= 0 ? '+' : '';
      return `${p.dimension}/${p.value}: ${sign}${p.score.toFixed(2)}`;
    });
    embed.addFields({ name: '📈 Évolution préférences', value: lines.join(' | ') });
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
