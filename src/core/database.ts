import Database from 'better-sqlite3';
import path from 'node:path';
import { getLogger } from './logger.js';
import { runMigrations } from './migrations/index.js';

export type SqliteDatabase = Database.Database;

let _db: SqliteDatabase | undefined;

export function createDatabase(dbPath?: string): SqliteDatabase {
  if (_db !== undefined) {
    return _db;
  }

  const logger = getLogger();
  const resolvedPath = dbPath ?? path.join(process.cwd(), 'data', 'tumulte.db');

  logger.info({ path: resolvedPath }, 'Opening SQLite database');

  _db = new Database(resolvedPath);

  // Pragmas for performance and safety
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  runMigrations(_db);

  logger.info('Database initialized and migrations applied');

  return _db;
}

export function getDatabase(): SqliteDatabase {
  if (_db === undefined) {
    throw new Error('Database not created. Call createDatabase() first.');
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db !== undefined) {
    _db.close();
    _db = undefined;
  }
}
