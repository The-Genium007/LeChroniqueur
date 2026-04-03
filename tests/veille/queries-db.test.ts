import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getCategoriesFromDb } from '../../src/veille/queries.js';

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
    it('should return empty array when DB table is empty', () => {
      const categories = getCategoriesFromDb(db);
      expect(categories.length).toBe(0);
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
});
