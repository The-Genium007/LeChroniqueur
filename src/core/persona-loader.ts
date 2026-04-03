import fs from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from './database.js';
import { getLogger } from './logger.js';

const DEFAULT_PERSONA = 'You are a content creation assistant for social media. Your style is engaging, authentic and adapted to the audience. Follow the user\'s tone and vocabulary guidelines.';

/**
 * Centralized persona loader with per-instance cache.
 * Replaces the duplicated loadPersona() in suggestions.ts, scripts.ts, deep-dive.ts.
 *
 * Priority:
 * 1. DB table `persona` (if row exists) — used by V2 instances
 * 2. File `prompts/SKILL.md` (fallback) — used by legacy mode
 * 3. DEFAULT_PERSONA constant — last resort
 */
class PersonaLoaderService {
  private cache = new Map<string, string>();
  private legacyCache: string | undefined;

  /**
   * Load persona for a specific instance from its DB.
   */
  loadForInstance(instanceId: string, db: SqliteDatabase): string {
    const cached = this.cache.get(instanceId);
    if (cached !== undefined) {
      return cached;
    }

    const logger = getLogger();

    // Try DB first
    const row = db.prepare('SELECT content FROM persona WHERE id = 1').get() as { content: string } | undefined;

    if (row !== undefined && row.content.length > 0) {
      logger.debug({ instanceId, source: 'db' }, 'Persona loaded');
      this.cache.set(instanceId, row.content);
      return row.content;
    }

    // Fallback to file
    const persona = this.loadFromFile();
    this.cache.set(instanceId, persona);
    return persona;
  }

  /**
   * Load persona from the legacy file system (prompts/SKILL.md).
   * Used by legacy single-instance mode.
   */
  loadLegacy(): string {
    if (this.legacyCache !== undefined) {
      return this.legacyCache;
    }

    this.legacyCache = this.loadFromFile();
    return this.legacyCache;
  }

  /**
   * Save persona to the instance DB.
   */
  saveForInstance(instanceId: string, db: SqliteDatabase, content: string): void {
    db.prepare(`
      INSERT INTO persona (id, content, updated_at) VALUES (1, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')
    `).run(content);

    // Invalidate cache
    this.cache.delete(instanceId);
  }

  /**
   * Invalidate cached persona for an instance (call after DB modification).
   */
  invalidate(instanceId: string): void {
    this.cache.delete(instanceId);
  }

  /**
   * Invalidate all cached personas.
   */
  invalidateAll(): void {
    this.cache.clear();
    this.legacyCache = undefined;
  }

  private loadFromFile(): string {
    const skillPath = path.join(process.cwd(), 'prompts', 'SKILL.md');

    if (!fs.existsSync(skillPath)) {
      return DEFAULT_PERSONA;
    }

    return fs.readFileSync(skillPath, 'utf-8');
  }
}

// Singleton
export const personaLoader = new PersonaLoaderService();
