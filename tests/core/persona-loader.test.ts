import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { personaLoader } from '../../src/core/persona-loader.js';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';

describe('PersonaLoader', () => {
  let db: Database.Database;

  beforeAll(() => {
    process.env['DRY_RUN'] = 'true';
    try { loadConfig(); } catch { /* already loaded */ }
    try { createLogger(); } catch { /* already created */ }
  });

  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare(`
      CREATE TABLE persona (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
    personaLoader.invalidateAll();
  });

  it('should load persona from DB when it exists', () => {
    db.prepare("INSERT INTO persona (id, content) VALUES (1, 'Tu es un expert JDR.')").run();
    const result = personaLoader.loadForInstance('test-instance', db);
    expect(result).toBe('Tu es un expert JDR.');
  });

  it('should fallback to file/default when DB is empty', () => {
    const result = personaLoader.loadForInstance('test-instance', db);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should cache the result per instance', () => {
    db.prepare("INSERT INTO persona (id, content) VALUES (1, 'Cached persona')").run();
    const first = personaLoader.loadForInstance('cache-test', db);
    db.prepare("UPDATE persona SET content = 'Modified' WHERE id = 1").run();
    const second = personaLoader.loadForInstance('cache-test', db);
    expect(first).toBe('Cached persona');
    expect(second).toBe('Cached persona');
  });

  it('should return fresh value after invalidation', () => {
    db.prepare("INSERT INTO persona (id, content) VALUES (1, 'Original')").run();
    personaLoader.loadForInstance('inv-test', db);
    db.prepare("UPDATE persona SET content = 'Updated' WHERE id = 1").run();
    personaLoader.invalidate('inv-test');
    const result = personaLoader.loadForInstance('inv-test', db);
    expect(result).toBe('Updated');
  });

  it('should save persona and invalidate cache', () => {
    personaLoader.saveForInstance('save-test', db, 'New persona content');
    const row = db.prepare('SELECT content FROM persona WHERE id = 1').get() as { content: string };
    expect(row.content).toBe('New persona content');
    const result = personaLoader.loadForInstance('save-test', db);
    expect(result).toBe('New persona content');
  });

  it('should update existing persona on save', () => {
    db.prepare("INSERT INTO persona (id, content) VALUES (1, 'Old')").run();
    personaLoader.saveForInstance('update-test', db, 'New');
    const row = db.prepare('SELECT content FROM persona WHERE id = 1').get() as { content: string };
    expect(row.content).toBe('New');
  });
});
