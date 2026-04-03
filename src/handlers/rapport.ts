import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { getProfile } from '../feedback/preference-learner.js';
import { recalculate } from '../feedback/preference-learner.js';
import { getWeeklyTotal, getMonthlyTotal } from '../budget/tracker.js';
import { weeklyReport as buildWeeklyReportV2, analyticsReport as buildAnalyticsReport } from '../discord/component-builder-v2.js';
import { sendSplit } from '../discord/message-splitter.js';
import type { InstanceContext } from '../registry/instance-context.js';
import { collectWeeklyMetrics } from '../analytics/collector.js';
import { getWeeklyStatsByPlatform, formatWeeklyStatsForReport } from '../analytics/aggregator.js';
import { aiAnalyzeSlots, formatSlotRecommendations } from '../analytics/slot-optimizer.js';
import { personaLoader } from '../core/persona-loader.js';

interface WeekTopArticle {
  readonly title: string;
  readonly translated_title: string | null;
  readonly score: number;
  readonly source: string;
  readonly url: string;
}

interface WeekPublication {
  readonly id: number;
  readonly platform: string;
  readonly content: string;
  readonly scheduled_at: string | null;
  readonly published_at: string | null;
  readonly metrics_views: number | null;
  readonly metrics_likes: number | null;
}

async function runRapportPipeline(
  db: SqliteDatabase,
  veilleChannel: TextChannel,
): Promise<void> {
  const logger = getLogger();

  logger.info('Generating weekly rapport');

  recalculate(db);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekStartStr = weekStart.toISOString();

  const topArticles = db.prepare(`
    SELECT title, translated_title, score, source, url
    FROM veille_articles
    WHERE collected_at >= ? AND score >= 7
    ORDER BY score DESC
    LIMIT 5
  `).all(weekStartStr) as WeekTopArticle[];

  const articleStats = db.prepare(`
    SELECT
      COUNT(*) as total_collected,
      SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) as proposed,
      SUM(CASE WHEN status = 'transformed' THEN 1 ELSE 0 END) as transformed,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) as archived
    FROM veille_articles
    WHERE collected_at >= ?
  `).get(weekStartStr) as {
    total_collected: number;
    proposed: number;
    transformed: number;
    archived: number;
  };

  const suggestionStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'go' THEN 1 ELSE 0 END) as go_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skip_count,
      SUM(CASE WHEN status = 'modified' THEN 1 ELSE 0 END) as modified_count
    FROM suggestions
    WHERE created_at >= ?
  `).get(weekStartStr) as {
    total: number;
    go_count: number;
    skip_count: number;
    modified_count: number;
  };

  const feedbackStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as negative
    FROM feedback_ratings
    WHERE rated_at >= ?
  `).get(weekStartStr) as { total: number; positive: number; negative: number };

  const publications = db.prepare(`
    SELECT id, platform, content, scheduled_at, published_at, metrics_views, metrics_likes
    FROM publications
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(weekStartStr) as WeekPublication[];

  const budgetWeekly = getWeeklyTotal(db);
  const budgetMonthly = getMonthlyTotal(db);

  const profile = getProfile(db);
  const topPreferences = profile
    .filter((p) => p.totalCount >= 3)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5);

  const payload = buildWeeklyReportV2({
    topArticles: topArticles.map((a) => ({
      title: a.translated_title ?? a.title,
      score: a.score,
      source: a.source,
      url: a.url,
    })),
    articleStats: {
      collected: articleStats.total_collected,
      proposed: articleStats.proposed,
      transformed: articleStats.transformed,
      archived: articleStats.archived,
    },
    suggestionStats: {
      total: suggestionStats.total,
      goCount: suggestionStats.go_count,
      skipCount: suggestionStats.skip_count,
      modifiedCount: suggestionStats.modified_count,
    },
    feedbackStats: {
      total: feedbackStats.total,
      positive: feedbackStats.positive,
      negative: feedbackStats.negative,
    },
    publications: publications.map((p) => ({
      platform: p.platform,
      content: p.content.slice(0, 100),
      scheduledAt: p.scheduled_at,
      views: p.metrics_views,
      likes: p.metrics_likes,
    })),
    budget: {
      weekly: budgetWeekly,
      monthly: budgetMonthly,
    },
    preferenceHighlights: topPreferences.map((p) => ({
      dimension: p.dimension,
      value: p.value,
      score: p.score,
    })),
  });

  await veilleChannel.send({
    components: payload.components as never[],
    flags: payload.flags,
  });

  logger.info('Weekly rapport sent');
}

async function runAnalyticsPipeline(
  db: SqliteDatabase,
  veilleChannel: TextChannel,
  configuredPlatforms: readonly string[],
  persona: string,
): Promise<void> {
  const logger = getLogger();

  // 1. Collect metrics from Postiz
  try {
    const collectionResult = await collectWeeklyMetrics(db);
    logger.info(collectionResult, 'Weekly metrics collected');
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to collect weekly metrics',
    );
  }

  // 2. Aggregate stats
  const weeklyStats = getWeeklyStatsByPlatform(db);
  const statsText = formatWeeklyStatsForReport(weeklyStats);

  // 3. AI slot analysis
  let slotsText: string;
  try {
    const { analysis, aiReasoning } = await aiAnalyzeSlots(db, configuredPlatforms, persona);
    slotsText = formatSlotRecommendations(analysis);
    if (aiReasoning.length > 0) {
      slotsText += `\n\n**🤖 Analyse IA**\n${aiReasoning}`;
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'AI slot analysis failed',
    );
    slotsText = 'Analyse des créneaux indisponible cette semaine.';
  }

  // 4. Send analytics report
  const analyticsPayload = buildAnalyticsReport({
    weeklyStats: statsText,
    slotRecommendations: slotsText,
  });

  await sendSplit(veilleChannel, analyticsPayload);

  logger.info('Analytics report sent');
}

export async function handleWeeklyRapport(ctx: InstanceContext): Promise<void> {
  await runRapportPipeline(ctx.db, ctx.channels.veille);
  const persona = personaLoader.loadForInstance(ctx.id, ctx.db);
  await runAnalyticsPipeline(
    ctx.db,
    ctx.channels.veille,
    ctx.config.content.platforms,
    persona,
  );
}
