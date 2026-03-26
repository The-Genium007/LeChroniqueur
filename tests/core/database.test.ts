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

describe('migrations', () => {
  it('should create all expected tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('_migrations');
    expect(tableNames).toContain('veille_articles');
    expect(tableNames).toContain('suggestions');
    expect(tableNames).toContain('publications');
    expect(tableNames).toContain('media');
    expect(tableNames).toContain('conversations');
    expect(tableNames).toContain('metrics');
    expect(tableNames).toContain('feedback_ratings');
    expect(tableNames).toContain('preference_profiles');
    expect(tableNames).toContain('cron_runs');
    expect(tableNames).toContain('budget_alerts');
  });

  it('should create FTS5 search_index', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_index'")
      .all();

    expect(tables).toHaveLength(1);
  });

  it('should record all migrations', () => {
    const migrations = db
      .prepare('SELECT name FROM _migrations ORDER BY id')
      .all() as Array<{ name: string }>;

    expect(migrations.length).toBe(15);
    expect(migrations[0]?.name).toBe('001_create_veille_articles');
    expect(migrations[14]?.name).toBe('015_create_config_history');
  });

  it('should be idempotent — running migrations twice does not fail', () => {
    // Running again should not throw
    expect(() => runMigrations(db)).not.toThrow();

    const migrations = db.prepare('SELECT COUNT(*) AS count FROM _migrations').get() as { count: number };
    expect(migrations.count).toBe(15);
  });
});

describe('veille_articles CRUD', () => {
  it('should insert and retrieve an article', () => {
    db.prepare(`
      INSERT INTO veille_articles (url, title, snippet, source, language, category, score, pillar)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('https://example.com/test', 'Test Article', 'A snippet', 'reddit', 'en', 'ttrpg_news', 8, 'trend');

    const article = db.prepare('SELECT * FROM veille_articles WHERE url = ?').get('https://example.com/test') as Record<string, unknown>;

    expect(article).toBeDefined();
    expect(article['title']).toBe('Test Article');
    expect(article['score']).toBe(8);
    expect(article['status']).toBe('new');
  });

  it('should enforce unique URL constraint', () => {
    db.prepare(`
      INSERT INTO veille_articles (url, title, source, language, category)
      VALUES (?, ?, ?, ?, ?)
    `).run('https://example.com/dup', 'First', 'google', 'en', 'streaming');

    expect(() => {
      db.prepare(`
        INSERT INTO veille_articles (url, title, source, language, category)
        VALUES (?, ?, ?, ?, ?)
      `).run('https://example.com/dup', 'Second', 'reddit', 'en', 'streaming');
    }).toThrow();
  });
});

describe('feedback_ratings CRUD', () => {
  it('should insert a rating', () => {
    // First create an article to rate
    db.prepare(`
      INSERT INTO veille_articles (url, title, source, language, category)
      VALUES (?, ?, ?, ?, ?)
    `).run('https://example.com/rated', 'Rated Article', 'reddit', 'en', 'ttrpg_news');

    db.prepare(`
      INSERT INTO feedback_ratings (target_table, target_id, rating, discord_user_id)
      VALUES (?, ?, ?, ?)
    `).run('veille_articles', 1, 1, 'user123');

    const rating = db.prepare('SELECT * FROM feedback_ratings WHERE target_id = 1').get() as Record<string, unknown>;
    expect(rating).toBeDefined();
    expect(rating['rating']).toBe(1);
  });

  it('should enforce unique constraint on target+user', () => {
    db.prepare(`
      INSERT INTO veille_articles (url, title, source, language, category)
      VALUES (?, ?, ?, ?, ?)
    `).run('https://example.com/unique', 'Unique', 'reddit', 'en', 'ttrpg_news');

    db.prepare(`
      INSERT INTO feedback_ratings (target_table, target_id, rating, discord_user_id)
      VALUES (?, ?, ?, ?)
    `).run('veille_articles', 1, 1, 'user123');

    // Same user, same target — should conflict
    expect(() => {
      db.prepare(`
        INSERT INTO feedback_ratings (target_table, target_id, rating, discord_user_id)
        VALUES (?, ?, ?, ?)
      `).run('veille_articles', 1, -1, 'user123');
    }).toThrow();
  });
});

describe('search_index FTS5', () => {
  it('should index and search documents', () => {
    db.prepare(`
      INSERT INTO search_index (title, snippet, content, source_table, source_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('Dragon Homebrew Guide', 'How to create custom dragons', 'Detailed guide', 'veille_articles', '1');

    db.prepare(`
      INSERT INTO search_index (title, snippet, content, source_table, source_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('Sondage TikTok', 'Meilleurs sondages pour stream', 'Tutorial', 'suggestions', '2');

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'dragon'
    `).all() as Array<{ title: string }>;

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Dragon Homebrew Guide');
  });

  it('should support accent-insensitive search', () => {
    db.prepare(`
      INSERT INTO search_index (title, snippet, content, source_table, source_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('Éléphant magique', 'Un éléphant dans un donjon', 'Contenu', 'veille_articles', '3');

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'elephant'
    `).all();

    expect(results).toHaveLength(1);
  });
});
