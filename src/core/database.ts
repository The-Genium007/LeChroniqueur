import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { getLogger } from './logger.js';
import { runMigrations } from './migrations/index.js';
import { runGlobalMigrations } from './migrations/global.js';

export type SqliteDatabase = Database.Database;

// ─── Global DB (bot.db) ───

let _globalDb: SqliteDatabase | undefined;

function applyPragmas(db: SqliteDatabase): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

export function createGlobalDatabase(dbPath?: string): SqliteDatabase {
  if (_globalDb !== undefined) {
    return _globalDb;
  }

  const logger = getLogger();
  const resolvedPath = dbPath ?? path.join(process.cwd(), 'data', 'bot.db');

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ path: resolvedPath }, 'Opening global database');

  _globalDb = new Database(resolvedPath);
  applyPragmas(_globalDb);
  runGlobalMigrations(_globalDb);

  logger.info('Global database initialized');

  return _globalDb;
}

export function getGlobalDatabase(): SqliteDatabase {
  if (_globalDb === undefined) {
    throw new Error('Global database not created. Call createGlobalDatabase() first.');
  }
  return _globalDb;
}

// ─── Instance DB (data/instances/{id}/database.db) ───

const _instanceDbs = new Map<string, SqliteDatabase>();

export function closeInstanceDatabase(instanceId: string): void {
  const db = _instanceDbs.get(instanceId);
  if (db !== undefined) {
    try { db.close(); } catch { /* already closed */ }
    _instanceDbs.delete(instanceId);
  }
}

export function createInstanceDatabase(instanceId: string, dbPath?: string): SqliteDatabase {
  const existing = _instanceDbs.get(instanceId);
  if (existing !== undefined) {
    // Check if the connection is still open
    try {
      existing.prepare('SELECT 1').get();
      return existing;
    } catch {
      // Connection is closed — remove stale reference and reopen
      _instanceDbs.delete(instanceId);
    }
  }

  const logger = getLogger();
  const resolvedPath = dbPath ?? path.join(process.cwd(), 'data', 'instances', instanceId, 'database.db');

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  logger.info({ instanceId, path: resolvedPath }, 'Opening instance database');

  const db = new Database(resolvedPath);
  applyPragmas(db);
  runMigrations(db);

  _instanceDbs.set(instanceId, db);

  logger.info({ instanceId }, 'Instance database initialized');

  return db;
}

export function getInstanceDatabase(instanceId: string): SqliteDatabase {
  const db = _instanceDbs.get(instanceId);
  if (db === undefined) {
    throw new Error(`Instance database '${instanceId}' not created. Call createInstanceDatabase() first.`);
  }
  return db;
}

// ─── Shutdown ───

export function closeAllDatabases(): void {
  if (_globalDb !== undefined) {
    _globalDb.close();
    _globalDb = undefined;
  }

  for (const [id, db] of _instanceDbs) {
    db.close();
    _instanceDbs.delete(id);
  }
}
