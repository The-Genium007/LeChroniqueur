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

function insertDoc(title: string, snippet: string, content: string, sourceTable: string, sourceId: number): void {
  db.prepare(`
    INSERT INTO search_index (title, snippet, content, source_table, source_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, snippet, content, sourceTable, String(sourceId));
}

describe('FTS5 search', () => {
  it('should find documents by title', () => {
    insertDoc('Dragon Homebrew Guide', 'Custom dragons for D&D', 'Full guide content', 'veille_articles', 1);
    insertDoc('Sondage TikTok viral', 'Meilleurs sondages stream', 'Tutorial content', 'suggestions', 2);

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'dragon'
    `).all() as Array<{ title: string }>;

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe('Dragon Homebrew Guide');
  });

  it('should find documents by snippet', () => {
    insertDoc('Title', 'sondage viewers interaction', 'Content', 'veille_articles', 1);

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'sondage'
    `).all();

    expect(results).toHaveLength(1);
  });

  it('should support OR queries', () => {
    insertDoc('Dragon article', 'About dragons', '', 'veille_articles', 1);
    insertDoc('Sondage article', 'About polls', '', 'suggestions', 2);
    insertDoc('Unrelated article', 'About cooking', '', 'veille_articles', 3);

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'dragon OR sondage'
    `).all();

    expect(results).toHaveLength(2);
  });

  it('should handle accent-insensitive search', () => {
    insertDoc('Événement spécial', 'Détails de événement', '', 'veille_articles', 1);

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'evenement'
    `).all();

    expect(results).toHaveLength(1);
  });

  it('should return empty for no matches', () => {
    insertDoc('Dragon article', 'About dragons', '', 'veille_articles', 1);

    const results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'nonexistent'
    `).all();

    expect(results).toHaveLength(0);
  });

  it('should handle removal of documents', () => {
    insertDoc('To remove', 'This will be removed', '', 'veille_articles', 99);

    let results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'removed'
    `).all();
    expect(results).toHaveLength(1);

    db.prepare('DELETE FROM search_index WHERE source_table = ? AND source_id = ?')
      .run('veille_articles', '99');

    results = db.prepare(`
      SELECT * FROM search_index WHERE search_index MATCH 'removed'
    `).all();
    expect(results).toHaveLength(0);
  });
});

describe('search with ranking', () => {
  it('should rank results by relevance', () => {
    // Document with "dragon" in title should rank higher
    insertDoc('Dragon Dragon Dragon', 'Many dragons', 'dragons everywhere', 'veille_articles', 1);
    insertDoc('A small dragon', 'Just one mention', 'No more', 'veille_articles', 2);

    const results = db.prepare(`
      SELECT *, rank FROM search_index WHERE search_index MATCH 'dragon' ORDER BY rank
    `).all() as Array<{ source_id: string; rank: number }>;

    expect(results).toHaveLength(2);
    // First result should have better (lower) rank
    expect(results[0]?.rank).toBeLessThan(results[1]!.rank);
  });
});
