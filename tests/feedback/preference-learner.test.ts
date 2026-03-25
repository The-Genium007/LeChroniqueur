import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/core/migrations/index.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

function insertArticle(url: string, title: string, source: string, category: string, pillar: string): number {
  const result = db.prepare(`
    INSERT INTO veille_articles (url, title, source, language, category, pillar)
    VALUES (?, ?, ?, 'en', ?, ?)
  `).run(url, title, source, category, pillar);
  return Number(result.lastInsertRowid);
}

function insertRating(targetId: number, rating: number): void {
  db.prepare(`
    INSERT INTO feedback_ratings (target_table, target_id, rating, discord_user_id)
    VALUES ('veille_articles', ?, ?, 'user123')
  `).run(targetId, rating);
}

describe('preference aggregation via SQL', () => {
  it('should aggregate source preferences', () => {
    // 3 reddit articles, 2 positive, 1 negative
    const a1 = insertArticle('https://r1.com', 'Reddit 1', 'reddit', 'ttrpg_news', 'trend');
    const a2 = insertArticle('https://r2.com', 'Reddit 2', 'reddit', 'ttrpg_news', 'trend');
    const a3 = insertArticle('https://r3.com', 'Reddit 3', 'reddit', 'ttrpg_news', 'trend');

    insertRating(a1, 1);
    insertRating(a2, 1);
    insertRating(a3, -1);

    const result = db.prepare(`
      SELECT a.source AS value,
             SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS positive,
             SUM(CASE WHEN r.rating = -1 THEN 1 ELSE 0 END) AS negative,
             COUNT(*) AS total
      FROM feedback_ratings r
      JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
      GROUP BY a.source
      HAVING COUNT(*) >= 3
    `).all() as Array<{ value: string; positive: number; negative: number; total: number }>;

    expect(result).toHaveLength(1);
    expect(result[0]?.value).toBe('reddit');
    expect(result[0]?.positive).toBe(2);
    expect(result[0]?.negative).toBe(1);

    // Score = (2 - 1) / 3 = 0.333...
    const score = (result[0]!.positive - result[0]!.negative) / result[0]!.total;
    expect(score).toBeCloseTo(0.333, 2);
  });

  it('should filter out dimensions with fewer than 3 ratings', () => {
    const a1 = insertArticle('https://g1.com', 'Google 1', 'google', 'streaming', 'tuto');
    const a2 = insertArticle('https://g2.com', 'Google 2', 'google', 'streaming', 'tuto');

    insertRating(a1, 1);
    insertRating(a2, 1);

    const result = db.prepare(`
      SELECT a.source AS value, COUNT(*) AS total
      FROM feedback_ratings r
      JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
      GROUP BY a.source
      HAVING COUNT(*) >= 3
    `).all();

    expect(result).toHaveLength(0);
  });

  it('should aggregate category preferences correctly', () => {
    const a1 = insertArticle('https://m1.com', 'Meme 1', 'reddit', 'ttrpg_memes', 'trend');
    const a2 = insertArticle('https://m2.com', 'Meme 2', 'imgur', 'ttrpg_memes', 'trend');
    const a3 = insertArticle('https://m3.com', 'Meme 3', 'reddit', 'ttrpg_memes', 'trend');
    const a4 = insertArticle('https://t1.com', 'Tech 1', 'hackernews', 'vtt_tech', 'product');
    const a5 = insertArticle('https://t2.com', 'Tech 2', 'google', 'vtt_tech', 'product');
    const a6 = insertArticle('https://t3.com', 'Tech 3', 'reddit', 'vtt_tech', 'product');

    // All memes positive
    insertRating(a1, 1);
    insertRating(a2, 1);
    insertRating(a3, 1);

    // Tech mixed
    insertRating(a4, 1);
    insertRating(a5, -1);
    insertRating(a6, -1);

    const result = db.prepare(`
      SELECT a.category AS value,
             SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS positive,
             SUM(CASE WHEN r.rating = -1 THEN 1 ELSE 0 END) AS negative,
             COUNT(*) AS total
      FROM feedback_ratings r
      JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
      GROUP BY a.category
      HAVING COUNT(*) >= 3
      ORDER BY value
    `).all() as Array<{ value: string; positive: number; negative: number; total: number }>;

    expect(result).toHaveLength(2);

    const memes = result.find((r) => r.value === 'ttrpg_memes');
    expect(memes?.positive).toBe(3);
    expect(memes?.negative).toBe(0);
    // Score = 3/3 = 1.0
    expect((memes!.positive - memes!.negative) / memes!.total).toBe(1.0);

    const tech = result.find((r) => r.value === 'vtt_tech');
    expect(tech?.positive).toBe(1);
    expect(tech?.negative).toBe(2);
    // Score = (1-2)/3 = -0.333
    expect((tech!.positive - tech!.negative) / tech!.total).toBeCloseTo(-0.333, 2);
  });
});
