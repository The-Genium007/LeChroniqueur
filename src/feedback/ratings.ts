import type { SqliteDatabase } from '../core/database.js';

export interface Rating {
  readonly id: number;
  readonly targetTable: string;
  readonly targetId: number;
  readonly rating: number;
  readonly discordUserId: string;
  readonly ratedAt: string;
}

export function upsertRating(
  db: SqliteDatabase,
  targetTable: string,
  targetId: number,
  rating: 1 | -1,
  userId: string,
): void {
  db.prepare(`
    INSERT INTO feedback_ratings (target_table, target_id, rating, discord_user_id, rated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(target_table, target_id, discord_user_id) DO UPDATE SET
      rating = excluded.rating,
      rated_at = datetime('now')
  `).run(targetTable, targetId, rating, userId);
}

export function getRatingsForTarget(
  db: SqliteDatabase,
  targetTable: string,
  targetId: number,
): readonly Rating[] {
  return db
    .prepare('SELECT * FROM feedback_ratings WHERE target_table = ? AND target_id = ?')
    .all(targetTable, targetId) as Rating[];
}

export function getRatingStats(
  db: SqliteDatabase,
  since: Date,
): { total: number; positive: number; negative: number } {
  const row = db
    .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END) as negative
      FROM feedback_ratings
      WHERE rated_at >= ?
    `)
    .get(since.toISOString()) as {
    total: number;
    positive: number;
    negative: number;
  };

  return row;
}
