import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCategoriesFromDb, seedCategories, getDefaultCategories } from '../../src/veille/queries.js';

describe('queries DB functions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.prepare(`
      CREATE TABLE veille_categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        keywords_en TEXT NOT NULL DEFAULT '[]',
        keywords_fr TEXT NOT NULL DEFAULT '[]',
        engines TEXT NOT NULL DEFAULT '[]',
        max_age_hours INTEGER NOT NULL DEFAULT 72,
        is_active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `).run();
  });

  describe('getCategoriesFromDb', () => {
    it('should return hardcoded defaults when DB table is empty', () => {
      const categories = getCategoriesFromDb(db);
      expect(categories.length).toBeGreaterThan(0);
      expect(categories[0]?.id).toBe('ttrpg_news');
    });

    it('should return DB categories when populated', () => {
      db.prepare(`
        INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines, max_age_hours, sort_order)
        VALUES ('custom_cat', 'Custom', '["test en"]', '["test fr"]', '["google"]', 48, 0)
      `).run();

      const categories = getCategoriesFromDb(db);
      expect(categories.length).toBe(1);
      expect(categories[0]?.id).toBe('custom_cat');
      expect(categories[0]?.label).toBe('Custom');
      expect(categories[0]?.keywords.en).toEqual(['test en']);
      expect(categories[0]?.keywords.fr).toEqual(['test fr']);
      expect(categories[0]?.engines).toEqual(['google']);
      expect(categories[0]?.maxAgeHours).toBe(48);
      expect(categories[0]?.isActive).toBe(true);
    });

    it('should only return active categories', () => {
      db.prepare(`
        INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines, is_active, sort_order)
        VALUES ('active', 'Active', '[]', '[]', '[]', 1, 0),
               ('inactive', 'Inactive', '[]', '[]', '[]', 0, 1)
      `).run();

      const categories = getCategoriesFromDb(db);
      expect(categories.length).toBe(1);
      expect(categories[0]?.id).toBe('active');
    });

    it('should respect sort_order', () => {
      db.prepare(`
        INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines, sort_order)
        VALUES ('b', 'B', '[]', '[]', '[]', 1),
               ('a', 'A', '[]', '[]', '[]', 0)
      `).run();

      const categories = getCategoriesFromDb(db);
      expect(categories[0]?.id).toBe('a');
      expect(categories[1]?.id).toBe('b');
    });
  });

  describe('seedCategories', () => {
    it('should seed default categories into empty table', () => {
      seedCategories(db);
      const count = db.prepare('SELECT COUNT(*) AS cnt FROM veille_categories').get() as { cnt: number };
      const defaults = getDefaultCategories();
      expect(count.cnt).toBe(defaults.length);
    });

    it('should not seed if table already has data', () => {
      db.prepare(`
        INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines)
        VALUES ('existing', 'Existing', '[]', '[]', '[]')
      `).run();

      seedCategories(db);

      const count = db.prepare('SELECT COUNT(*) AS cnt FROM veille_categories').get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it('should preserve sort order', () => {
      seedCategories(db);
      const first = db.prepare('SELECT id FROM veille_categories ORDER BY sort_order ASC LIMIT 1').get() as { id: string };
      const defaults = getDefaultCategories();
      expect(first.id).toBe(defaults[0]?.id);
    });
  });
});
