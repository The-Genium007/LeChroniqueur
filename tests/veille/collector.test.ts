import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/core/migrations/index.js';
import type { SearxngResult } from '../../src/services/searxng.js';

// Mock SearXNG
const mockSearch = vi.fn<(query: string, options?: unknown) => Promise<readonly SearxngResult[]>>();

vi.mock('../../src/services/searxng.js', () => ({
  search: (...args: unknown[]) => mockSearch(...(args as [string, unknown])),
}));

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { collect } from '../../src/veille/collector.js';
import type { VeilleCategory } from '../../src/veille/queries.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

function makeSearxngResult(overrides: Partial<SearxngResult> = {}): SearxngResult {
  return {
    url: 'https://example.com/article',
    title: 'Test Article',
    content: 'A snippet about TTRPG',
    engine: 'google',
    publishedDate: new Date().toISOString(),
    ...overrides,
  };
}

function makeCategory(overrides: Partial<VeilleCategory> = {}): VeilleCategory {
  return {
    id: 'test_cat',
    label: 'Test',
    keywords: { en: ['test query'], fr: [] },
    engines: ['google'],
    maxAgeHours: 72,
    ...overrides,
  };
}

describe('collect', () => {
  it('should return articles from SearXNG results', async () => {
    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/1', title: 'Article One' }),
      makeSearxngResult({ url: 'https://example.com/2', title: 'Article Two' }),
    ]);

    const result = await collect(db, [makeCategory()]);

    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]?.title).toBe('Article One');
    expect(result.articles[1]?.title).toBe('Article Two');
    expect(result.stats.totalFetched).toBe(2);
    expect(result.stats.kept).toBe(2);
  });

  it('should deduplicate articles by URL within a batch', async () => {
    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/dup', title: 'First' }),
      makeSearxngResult({ url: 'https://example.com/dup', title: 'Duplicate' }),
      makeSearxngResult({ url: 'https://example.com/unique', title: 'Unique' }),
    ]);

    const result = await collect(db, [makeCategory()]);

    expect(result.articles).toHaveLength(2);
    expect(result.stats.deduplicated).toBe(1);
  });

  it('should deduplicate against existing articles in database', async () => {
    // Insert an existing article in DB
    db.prepare(
      'INSERT INTO veille_articles (url, title, source, language, category) VALUES (?, ?, ?, ?, ?)',
    ).run('https://example.com/existing', 'Existing', 'google', 'en', 'test_cat');

    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/existing', title: 'Existing Again' }),
      makeSearxngResult({ url: 'https://example.com/new', title: 'New Article' }),
    ]);

    const result = await collect(db, [makeCategory()]);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.url).toBe('https://example.com/new');
    expect(result.stats.deduplicated).toBe(1);
  });

  it('should filter out articles older than maxAgeHours', async () => {
    const oldDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(); // 200h ago
    const recentDate = new Date().toISOString();

    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/old', publishedDate: oldDate }),
      makeSearxngResult({ url: 'https://example.com/recent', publishedDate: recentDate }),
    ]);

    const result = await collect(db, [makeCategory({ maxAgeHours: 72 })]);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.url).toBe('https://example.com/recent');
  });

  it('should keep articles with no publishedDate (assumed recent)', async () => {
    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/nodate', publishedDate: undefined }),
    ]);

    const result = await collect(db, [makeCategory()]);

    expect(result.articles).toHaveLength(1);
  });

  it('should keep articles with invalid publishedDate (assumed recent)', async () => {
    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/baddate', publishedDate: 'not-a-date' }),
    ]);

    const result = await collect(db, [makeCategory()]);

    expect(result.articles).toHaveLength(1);
  });

  it('should continue when a SearXNG query fails', async () => {
    const category = makeCategory({
      keywords: { en: ['query1', 'query2'], fr: [] },
    });

    mockSearch
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce([
        makeSearxngResult({ url: 'https://example.com/ok' }),
      ]);

    const result = await collect(db, [category]);

    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.url).toBe('https://example.com/ok');
  });

  it('should map SearXNG fields to RawArticle fields correctly', async () => {
    mockSearch.mockResolvedValue([
      makeSearxngResult({
        url: 'https://example.com/mapped',
        title: 'Mapped Title',
        content: 'Mapped snippet',
        engine: 'reddit',
        publishedDate: new Date().toISOString(),
        thumbnail: 'https://img.example.com/thumb.jpg',
      }),
    ]);

    const result = await collect(db, [makeCategory()]);

    const article = result.articles[0];
    expect(article?.url).toBe('https://example.com/mapped');
    expect(article?.title).toBe('Mapped Title');
    expect(article?.snippet).toBe('Mapped snippet');
    expect(article?.source).toBe('reddit');
    expect(article?.thumbnailUrl).toBe('https://img.example.com/thumb.jpg');
    expect(article?.publishedDate).toBeDefined();
    expect(article?.language).toBe('en');
    expect(article?.category).toBe('test_cat');
  });

  it('should return correct stats summary', async () => {
    const oldDate = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();

    // Insert existing article
    db.prepare(
      'INSERT INTO veille_articles (url, title, source, language, category) VALUES (?, ?, ?, ?, ?)',
    ).run('https://example.com/db-dup', 'DB Dup', 'google', 'en', 'test_cat');

    mockSearch.mockResolvedValue([
      makeSearxngResult({ url: 'https://example.com/a' }),
      makeSearxngResult({ url: 'https://example.com/a' }), // batch dup
      makeSearxngResult({ url: 'https://example.com/db-dup' }), // db dup
      makeSearxngResult({ url: 'https://example.com/old', publishedDate: oldDate }), // filtered by age
      makeSearxngResult({ url: 'https://example.com/kept' }),
    ]);

    const result = await collect(db, [makeCategory({ maxAgeHours: 72 })]);

    expect(result.stats.totalFetched).toBe(5);
    expect(result.stats.deduplicated).toBe(2); // 1 batch + 1 db
    expect(result.stats.kept).toBe(2); // /a and /kept
  });

  it('should handle empty results', async () => {
    mockSearch.mockResolvedValue([]);

    const result = await collect(db, [makeCategory()]);

    expect(result.articles).toHaveLength(0);
    expect(result.stats.totalFetched).toBe(0);
    expect(result.stats.kept).toBe(0);
  });
});
