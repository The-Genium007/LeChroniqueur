import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';

export interface PreferenceEntry {
  readonly dimension: string;
  readonly value: string;
  readonly positiveCount: number;
  readonly negativeCount: number;
  readonly totalCount: number;
  readonly score: number;
}

const MIN_RATINGS_THRESHOLD = 3;

const STOP_WORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'this', 'that', 'these', 'those', 'not', 'you',
  'your', 'they', 'them', 'their', 'what', 'which', 'who', 'when', 'where',
  'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some',
  'any', 'new', 'just', 'about', 'into', 'over', 'after',
  // French
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'mais',
  'dans', 'sur', 'pour', 'par', 'avec', 'est', 'sont', 'qui', 'que',
  'quoi', 'ce', 'cette', 'ces', 'pas', 'plus', 'très', 'bien', 'aussi',
  'fait', 'faire', 'tout', 'tous', 'toute', 'toutes', 'être', 'avoir',
]);

function extractKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-zàâäéèêëïîôùûüÿç\s'-]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

export function recalculate(db: SqliteDatabase): void {
  const logger = getLogger();

  // Clear existing profiles
  db.prepare('DELETE FROM preference_profiles').run();

  // ─── Source preferences ───
  const sourceRows = db.prepare(`
    SELECT a.source AS value,
           SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN r.rating = -1 THEN 1 ELSE 0 END) AS negative,
           COUNT(*) AS total
    FROM feedback_ratings r
    JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
    GROUP BY a.source
    HAVING COUNT(*) >= ?
  `).all(MIN_RATINGS_THRESHOLD) as Array<{
    value: string;
    positive: number;
    negative: number;
    total: number;
  }>;

  // ─── Category preferences ───
  const categoryRows = db.prepare(`
    SELECT a.category AS value,
           SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN r.rating = -1 THEN 1 ELSE 0 END) AS negative,
           COUNT(*) AS total
    FROM feedback_ratings r
    JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
    GROUP BY a.category
    HAVING COUNT(*) >= ?
  `).all(MIN_RATINGS_THRESHOLD) as Array<{
    value: string;
    positive: number;
    negative: number;
    total: number;
  }>;

  // ─── Pillar preferences ───
  const pillarRows = db.prepare(`
    SELECT a.pillar AS value,
           SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN r.rating = -1 THEN 1 ELSE 0 END) AS negative,
           COUNT(*) AS total
    FROM feedback_ratings r
    JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
    WHERE a.pillar IS NOT NULL
    GROUP BY a.pillar
    HAVING COUNT(*) >= ?
  `).all(MIN_RATINGS_THRESHOLD) as Array<{
    value: string;
    positive: number;
    negative: number;
    total: number;
  }>;

  // ─── Keyword preferences ───
  const ratedArticles = db.prepare(`
    SELECT a.title, r.rating
    FROM feedback_ratings r
    JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
  `).all() as Array<{ title: string; rating: number }>;

  const keywordStats = new Map<string, { positive: number; negative: number; total: number }>();

  for (const row of ratedArticles) {
    const keywords = extractKeywords(row.title);
    for (const keyword of keywords) {
      const existing = keywordStats.get(keyword) ?? { positive: 0, negative: 0, total: 0 };
      existing.total += 1;
      if (row.rating === 1) {
        existing.positive += 1;
      } else {
        existing.negative += 1;
      }
      keywordStats.set(keyword, existing);
    }
  }

  const keywordRows = Array.from(keywordStats.entries())
    .filter(([_, stats]) => stats.total >= MIN_RATINGS_THRESHOLD)
    .map(([keyword, stats]) => ({
      value: keyword,
      positive: stats.positive,
      negative: stats.negative,
      total: stats.total,
    }));

  // ─── Insert all preferences ───
  const insertStmt = db.prepare(`
    INSERT INTO preference_profiles (dimension, value, positive_count, negative_count, total_count, score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertAll = db.transaction(() => {
    const allEntries = [
      ...sourceRows.map((r) => ({ dimension: 'source', ...r })),
      ...categoryRows.map((r) => ({ dimension: 'category', ...r })),
      ...pillarRows.map((r) => ({ dimension: 'pillar', ...r })),
      ...keywordRows.map((r) => ({ dimension: 'keyword', ...r })),
    ];

    for (const entry of allEntries) {
      const score = entry.total > 0 ? (entry.positive - entry.negative) / entry.total : 0;
      insertStmt.run(entry.dimension, entry.value, entry.positive, entry.negative, entry.total, score);
    }

    return allEntries.length;
  });

  const count = insertAll();
  logger.info({ entries: count }, 'Preference profiles recalculated');
}

export function getProfile(db: SqliteDatabase): readonly PreferenceEntry[] {
  return db.prepare(`
    SELECT dimension, value, positive_count AS positiveCount,
           negative_count AS negativeCount, total_count AS totalCount, score
    FROM preference_profiles
    ORDER BY dimension, score DESC
  `).all() as PreferenceEntry[];
}

export function formatProfileForPrompt(db: SqliteDatabase): string {
  const entries = getProfile(db);

  if (entries.length === 0) {
    return 'Aucun profil de préférences disponible.';
  }

  const totalRatings = entries.reduce((sum, e) => sum + e.totalCount, 0);
  const lines = [`Profil de préférences (basé sur ${String(totalRatings)} ratings) :`];

  const dimensions = ['source', 'category', 'pillar', 'keyword'] as const;
  const labels: Record<string, string> = {
    source: 'Sources',
    category: 'Catégories',
    pillar: 'Piliers',
    keyword: 'Mots-clés',
  };

  for (const dim of dimensions) {
    const dimEntries = entries.filter((e) => e.dimension === dim);
    if (dimEntries.length === 0) continue;

    lines.push(`\n${labels[dim]} :`);
    for (const e of dimEntries.slice(0, 10)) {
      const sign = e.score >= 0 ? '+' : '';
      lines.push(`  ${e.value}: ${sign}${e.score.toFixed(2)} (${String(e.totalCount)} ratings)`);
    }
  }

  return lines.join('\n');
}
