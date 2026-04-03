import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';

// ─── Types ───

export interface PlatformDayHourStats {
  readonly platform: string;
  readonly dayOfWeek: number;
  readonly hour: number;
  readonly avgEngagement: number;
  readonly totalPosts: number;
  readonly avgViews: number;
  readonly avgLikes: number;
}

export interface PlatformWeeklyStats {
  readonly platform: string;
  readonly totalViews: number;
  readonly totalLikes: number;
  readonly totalComments: number;
  readonly totalShares: number;
  readonly postCount: number;
  readonly topMetric: string;
  readonly topValue: number;
}

interface MetricRow {
  metric_name: string;
  total_value: number;
}

interface ScheduleRow {
  day_of_week: number;
  hour: number;
  avg_engagement: number;
  post_count: number;
}

// ─── Aggregation functions ───

/**
 * Gets aggregated weekly stats per platform from social_metrics.
 */
export function getWeeklyStatsByPlatform(db: SqliteDatabase): readonly PlatformWeeklyStats[] {
  const logger = getLogger();

  const platforms = db.prepare(`
    SELECT DISTINCT platform FROM social_metrics
    WHERE metric_date >= date('now', '-7 days')
  `).all() as Array<{ platform: string }>;

  const stats: PlatformWeeklyStats[] = [];

  for (const { platform } of platforms) {
    const rows = db.prepare(`
      SELECT metric_name, SUM(metric_value) as total_value
      FROM social_metrics
      WHERE platform = ? AND metric_date >= date('now', '-7 days')
      GROUP BY metric_name
    `).all(platform) as MetricRow[];

    const metrics: Record<string, number> = {};
    for (const row of rows) {
      metrics[row.metric_name] = row.total_value;
    }

    const postCount = db.prepare(`
      SELECT COUNT(DISTINCT publication_id) as count
      FROM social_metrics
      WHERE platform = ? AND metric_date >= date('now', '-7 days')
    `).get(platform) as { count: number };

    // Find the top metric
    let topMetric = '';
    let topValue = 0;
    for (const [name, value] of Object.entries(metrics)) {
      if (value > topValue) {
        topMetric = name;
        topValue = value;
      }
    }

    stats.push({
      platform,
      totalViews: metrics['views'] ?? metrics['impressions'] ?? 0,
      totalLikes: metrics['likes'] ?? 0,
      totalComments: metrics['comments'] ?? 0,
      totalShares: metrics['shares'] ?? 0,
      postCount: postCount.count,
      topMetric,
      topValue,
    });
  }

  logger.debug({ platformCount: stats.length }, 'Weekly stats aggregated');

  return stats;
}

/**
 * Gets engagement data grouped by day of week and hour for a platform.
 * Used to determine optimal posting times.
 */
export function getEngagementBySchedule(
  db: SqliteDatabase,
  platform: string,
): readonly PlatformDayHourStats[] {
  // Join social_metrics with publications to get scheduled_at timestamps
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%w', p.scheduled_at) AS INTEGER) as day_of_week,
      CAST(strftime('%H', p.scheduled_at) AS INTEGER) as hour,
      AVG(sm.metric_value) as avg_engagement,
      COUNT(DISTINCT p.id) as post_count
    FROM social_metrics sm
    JOIN publications p ON sm.publication_id = p.id
    WHERE sm.platform = ?
      AND sm.metric_name IN ('likes', 'views', 'impressions', 'engagement')
      AND p.scheduled_at IS NOT NULL
    GROUP BY day_of_week, hour
    HAVING post_count >= 1
    ORDER BY avg_engagement DESC
  `).all(platform) as ScheduleRow[];

  return rows.map((row) => ({
    platform,
    dayOfWeek: row.day_of_week,
    hour: row.hour,
    avgEngagement: row.avg_engagement,
    totalPosts: row.post_count,
    avgViews: 0,
    avgLikes: 0,
  }));
}

/**
 * Returns the number of published posts per platform (for the minimum threshold check).
 */
export function getPublicationCountByPlatform(db: SqliteDatabase): ReadonlyMap<string, number> {
  const rows = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM publications
    WHERE status IN ('published', 'scheduled') AND postiz_post_id IS NOT NULL
    GROUP BY platform
  `).all() as Array<{ platform: string; count: number }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.platform, row.count);
  }
  return map;
}

/**
 * Formats weekly stats for the rapport hebdomadaire.
 */
export function formatWeeklyStatsForReport(stats: readonly PlatformWeeklyStats[]): string {
  if (stats.length === 0) {
    return 'Aucune donnée analytics cette semaine.';
  }

  const lines: string[] = ['**📊 Performance réseaux sociaux**', ''];

  for (const stat of stats) {
    const emoji = getPlatformEmoji(stat.platform);
    lines.push(
      `${emoji} **${stat.platform}** (${String(stat.postCount)} posts)`,
      `   👁️ ${String(stat.totalViews)} vues · ❤️ ${String(stat.totalLikes)} likes · 💬 ${String(stat.totalComments)} commentaires · 🔄 ${String(stat.totalShares)} partages`,
    );
  }

  return lines.join('\n');
}

function getPlatformEmoji(platform: string): string {
  const emojis: Record<string, string> = {
    tiktok: '📱',
    instagram: '📸',
    x: '🐦',
    linkedin: '💼',
    facebook: '📘',
    youtube: '📺',
    threads: '🧵',
    bluesky: '🦋',
    reddit: '🤖',
    pinterest: '📌',
    mastodon: '🐘',
  };
  return emojis[platform] ?? '📊';
}
