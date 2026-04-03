import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { getPostAnalytics, type PostizAnalyticsMetric } from '../services/postiz.js';

// ─── Types ───

interface PublicationRow {
  id: number;
  postiz_post_id: string;
  platform: string;
  derivation_id: number | null;
}

export interface CollectionResult {
  readonly publicationsProcessed: number;
  readonly metricsCollected: number;
  readonly errors: number;
}

// ─── Collector ───

/**
 * Collects analytics metrics from Postiz for all published posts.
 * Fetches data for the last 7 days and stores in social_metrics.
 */
export async function collectWeeklyMetrics(db: SqliteDatabase): Promise<CollectionResult> {
  const logger = getLogger();

  // Get all publications that have a Postiz post ID
  const publications = db.prepare(`
    SELECT id, postiz_post_id, platform, derivation_id
    FROM publications
    WHERE postiz_post_id IS NOT NULL
      AND status IN ('scheduled', 'published')
  `).all() as PublicationRow[];

  logger.info({ count: publications.length }, 'Collecting weekly metrics from Postiz');

  let metricsCollected = 0;
  let errors = 0;

  for (const pub of publications) {
    try {
      const analytics = await getPostAnalytics(pub.postiz_post_id, 7);
      const stored = storeMetrics(db, pub.id, pub.derivation_id, pub.postiz_post_id, pub.platform, analytics);
      metricsCollected += stored;

      // Mark as published if not already
      db.prepare(`
        UPDATE publications SET status = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP)
        WHERE id = ? AND status = 'scheduled'
      `).run(pub.id);
    } catch (error) {
      errors++;
      logger.warn(
        { publicationId: pub.id, postizPostId: pub.postiz_post_id, error: error instanceof Error ? error.message : String(error) },
        'Failed to collect metrics for publication',
      );
    }
  }

  logger.info({ publicationsProcessed: publications.length, metricsCollected, errors }, 'Weekly metrics collection complete');

  return { publicationsProcessed: publications.length, metricsCollected, errors };
}

/**
 * Stores analytics metrics in the social_metrics table.
 * Uses UPSERT to avoid duplicates for the same publication/metric/date.
 */
function storeMetrics(
  db: SqliteDatabase,
  publicationId: number,
  derivationId: number | null,
  postizPostId: string,
  platform: string,
  analytics: readonly PostizAnalyticsMetric[],
): number {
  let count = 0;

  const upsert = db.prepare(`
    INSERT INTO social_metrics (publication_id, derivation_id, postiz_post_id, platform, metric_name, metric_value, metric_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET metric_value = excluded.metric_value, collected_at = CURRENT_TIMESTAMP
  `);

  for (const metric of analytics) {
    for (const dataPoint of metric.data) {
      const value = parseInt(dataPoint.total, 10);
      if (isNaN(value)) continue;

      upsert.run(
        publicationId,
        derivationId,
        postizPostId,
        platform,
        metric.label.toLowerCase(),
        value,
        dataPoint.date,
      );
      count++;
    }
  }

  // Also update the legacy metrics columns on publications
  updatePublicationMetrics(db, publicationId, analytics);

  return count;
}

/**
 * Updates the legacy metrics_* columns on the publications table.
 */
function updatePublicationMetrics(
  db: SqliteDatabase,
  publicationId: number,
  analytics: readonly PostizAnalyticsMetric[],
): void {
  // Sum up latest values for each metric type
  const latestValues: Record<string, number> = {};

  for (const metric of analytics) {
    const lastPoint = metric.data.at(-1);
    if (lastPoint !== undefined) {
      latestValues[metric.label.toLowerCase()] = parseInt(lastPoint.total, 10) || 0;
    }
  }

  db.prepare(`
    UPDATE publications SET
      metrics_views = ?,
      metrics_likes = ?,
      metrics_comments = ?,
      metrics_shares = ?,
      metrics_saves = ?,
      metrics_updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    latestValues['views'] ?? latestValues['impressions'] ?? null,
    latestValues['likes'] ?? null,
    latestValues['comments'] ?? null,
    latestValues['shares'] ?? latestValues['retweets'] ?? null,
    latestValues['saves'] ?? latestValues['bookmarks'] ?? null,
    publicationId,
  );
}
