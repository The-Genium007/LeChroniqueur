import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { getProfile } from '../feedback/preference-learner.js';
import { recalculate } from '../feedback/preference-learner.js';
import {
  getWeeklyTotal,
  getMonthlyTotal,
} from '../budget/tracker.js';
import {
  weeklyReport as buildWeeklyReport,
} from '../discord/message-builder.js';

interface RapportDeps {
  readonly db: SqliteDatabase;
  readonly veilleChannel: TextChannel;
  readonly adminChannel: TextChannel;
}

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

export async function handleWeeklyRapport(deps: RapportDeps): Promise<void> {
  const logger = getLogger();
  const { db, veilleChannel, adminChannel } = deps;

  logger.info('Generating weekly rapport');

  // Recalculate preferences before rapport
  recalculate(db);

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekStartStr = weekStart.toISOString();

  // ─── Top articles of the week ───
  const topArticles = db.prepare(`
    SELECT title, translated_title, score, source, url
    FROM veille_articles
    WHERE collected_at >= ? AND score >= 7
    ORDER BY score DESC
    LIMIT 5
  `).all(weekStartStr) as WeekTopArticle[];

  // ─── Week stats ───
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

  // ─── Publications this week ───
  const publications = db.prepare(`
    SELECT id, platform, content, scheduled_at, published_at, metrics_views, metrics_likes
    FROM publications
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(weekStartStr) as WeekPublication[];

  // ─── Budget ───
  const budgetWeekly = getWeeklyTotal(db);
  const budgetMonthly = getMonthlyTotal(db);

  // ─── Preference profile highlights ───
  const profile = getProfile(db);
  const topPreferences = profile
    .filter((p) => p.totalCount >= 3)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 5);

  // ─── Build rapport ───
  const payload = buildWeeklyReport({
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
    embeds: payload.embeds,
    components: payload.components,
  });

  // If there are publications without metrics, ask for them in #admin
  const pubsWithoutMetrics = publications.filter(
    (p) => p.metrics_views === null && p.published_at !== null,
  );

  if (pubsWithoutMetrics.length > 0) {
    const lines = pubsWithoutMetrics.map((p) => {
      const preview = p.content.slice(0, 60).replace(/\n/g, ' ');
      return `• **#${String(p.id)}** (${p.platform}) : "${preview}..."`;
    });

    await adminChannel.send({
      content: [
        '📊 **Métriques manquantes** — ces publications n\'ont pas encore de stats :',
        '',
        ...lines,
        '',
        'Pour chaque post, envoie : `/metrics <id> vues=X likes=X commentaires=X partages=X saves=X`',
        '(commande à venir — pour l\'instant, note les chiffres et on les ajoutera)',
      ].join('\n'),
    });
  }

  logger.info('Weekly rapport sent');
}
