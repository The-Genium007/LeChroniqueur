import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/core/migrations/index.js';
import { upsertRating, getRatingsForTarget, getRatingStats } from '../../src/feedback/ratings.js';

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

function insertArticle(url: string): number {
  const result = db.prepare(
    'INSERT INTO veille_articles (url, title, source, language, category) VALUES (?, ?, ?, ?, ?)',
  ).run(url, 'Test', 'reddit', 'en', 'ttrpg_news');
  return Number(result.lastInsertRowid);
}

describe('upsertRating', () => {
  it('should insert a new rating', () => {
    const articleId = insertArticle('https://example.com/1');

    upsertRating(db, 'veille_articles', articleId, 1, 'user-a');

    const ratings = getRatingsForTarget(db, 'veille_articles', articleId);
    expect(ratings).toHaveLength(1);
    expect(ratings[0]?.rating).toBe(1);

    // DB returns snake_case column names
    const raw = ratings[0] as Record<string, unknown>;
    expect(raw['discord_user_id']).toBe('user-a');
  });

  it('should update existing rating on upsert (same user, same target)', () => {
    const articleId = insertArticle('https://example.com/2');

    upsertRating(db, 'veille_articles', articleId, 1, 'user-a');
    upsertRating(db, 'veille_articles', articleId, -1, 'user-a');

    const ratings = getRatingsForTarget(db, 'veille_articles', articleId);
    expect(ratings).toHaveLength(1);
    expect(ratings[0]?.rating).toBe(-1);
  });

  it('should allow different users to rate the same target', () => {
    const articleId = insertArticle('https://example.com/3');

    upsertRating(db, 'veille_articles', articleId, 1, 'user-a');
    upsertRating(db, 'veille_articles', articleId, -1, 'user-b');

    const ratings = getRatingsForTarget(db, 'veille_articles', articleId);
    expect(ratings).toHaveLength(2);
  });

  it('should allow same user to rate different targets', () => {
    const id1 = insertArticle('https://example.com/4');
    const id2 = insertArticle('https://example.com/5');

    upsertRating(db, 'veille_articles', id1, 1, 'user-a');
    upsertRating(db, 'veille_articles', id2, -1, 'user-a');

    expect(getRatingsForTarget(db, 'veille_articles', id1)).toHaveLength(1);
    expect(getRatingsForTarget(db, 'veille_articles', id2)).toHaveLength(1);
  });
});

describe('getRatingsForTarget', () => {
  it('should return empty array when no ratings exist', () => {
    const ratings = getRatingsForTarget(db, 'veille_articles', 999);
    expect(ratings).toHaveLength(0);
  });

  it('should return only ratings for the specified target', () => {
    const id1 = insertArticle('https://example.com/a');
    const id2 = insertArticle('https://example.com/b');

    upsertRating(db, 'veille_articles', id1, 1, 'user-a');
    upsertRating(db, 'veille_articles', id1, -1, 'user-b');
    upsertRating(db, 'veille_articles', id2, 1, 'user-a');

    const ratings = getRatingsForTarget(db, 'veille_articles', id1);
    expect(ratings).toHaveLength(2);
  });
});

describe('getRatingStats', () => {
  it('should return zero counts when no ratings exist', () => {
    const stats = getRatingStats(db, new Date(0));

    // SUM() returns null when no rows match — the source code returns raw SQL values
    expect(stats.total).toBe(0);
    expect(stats.positive ?? 0).toBe(0);
    expect(stats.negative ?? 0).toBe(0);
  });

  it('should count positive and negative ratings', () => {
    const id1 = insertArticle('https://example.com/s1');
    const id2 = insertArticle('https://example.com/s2');

    upsertRating(db, 'veille_articles', id1, 1, 'user-a');
    upsertRating(db, 'veille_articles', id1, 1, 'user-b');
    upsertRating(db, 'veille_articles', id2, -1, 'user-c');

    const stats = getRatingStats(db, new Date(0));

    expect(stats.total).toBe(3);
    expect(stats.positive).toBe(2);
    expect(stats.negative).toBe(1);
  });

  it('should filter by since date', () => {
    const articleId = insertArticle('https://example.com/dated');

    upsertRating(db, 'veille_articles', articleId, 1, 'user-a');

    // Query with a future date — should find nothing
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const stats = getRatingStats(db, futureDate);

    expect(stats.total).toBe(0);
  });

  it('should reflect upserted ratings correctly', () => {
    const articleId = insertArticle('https://example.com/upsert-stats');

    // Rate positive, then change to negative
    upsertRating(db, 'veille_articles', articleId, 1, 'user-a');
    upsertRating(db, 'veille_articles', articleId, -1, 'user-a');

    const stats = getRatingStats(db, new Date(0));

    expect(stats.total).toBe(1);
    expect(stats.positive).toBe(0);
    expect(stats.negative).toBe(1);
  });
});
