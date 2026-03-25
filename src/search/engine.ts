import type { SqliteDatabase } from '../core/database.js';

export interface SearchDocument {
  readonly title: string;
  readonly snippet: string;
  readonly content: string;
  readonly sourceTable: string;
  readonly sourceId: number;
}

export interface SearchResult {
  readonly sourceTable: string;
  readonly sourceId: number;
  readonly title: string;
  readonly snippet: string;
  readonly rank: number;
}

export function indexDocument(db: SqliteDatabase, doc: SearchDocument): void {
  // Remove existing entry if any
  db.prepare(
    'DELETE FROM search_index WHERE source_table = ? AND source_id = ?',
  ).run(doc.sourceTable, String(doc.sourceId));

  db.prepare(`
    INSERT INTO search_index (title, snippet, content, source_table, source_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(doc.title, doc.snippet, doc.content, doc.sourceTable, String(doc.sourceId));
}

export function removeDocument(
  db: SqliteDatabase,
  sourceTable: string,
  sourceId: number,
): void {
  db.prepare(
    'DELETE FROM search_index WHERE source_table = ? AND source_id = ?',
  ).run(sourceTable, String(sourceId));
}

export function search(
  db: SqliteDatabase,
  query: string,
  limit: number = 10,
  offset: number = 0,
): readonly SearchResult[] {
  // Sanitize query for FTS5 — escape special characters
  const sanitized = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' OR ');

  if (sanitized.length === 0) {
    return [];
  }

  const results = db.prepare(`
    SELECT source_table AS sourceTable,
           CAST(source_id AS INTEGER) AS sourceId,
           title,
           snippet,
           rank
    FROM search_index
    WHERE search_index MATCH ?
    ORDER BY rank
    LIMIT ? OFFSET ?
  `).all(sanitized, limit, offset) as SearchResult[];

  return results;
}

export function searchCount(db: SqliteDatabase, query: string): number {
  const sanitized = query
    .replace(/['"]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(' OR ');

  if (sanitized.length === 0) {
    return 0;
  }

  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM search_index
    WHERE search_index MATCH ?
  `).get(sanitized) as { count: number };

  return row.count;
}
