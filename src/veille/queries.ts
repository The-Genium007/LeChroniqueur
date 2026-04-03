import type { SqliteDatabase } from '../core/database.js';
import type { InstanceVeilleCategory } from '../core/config.js';

export interface VeilleCategory {
  readonly id: string;
  readonly label: string;
  readonly keywords: {
    readonly en: readonly string[];
    readonly fr: readonly string[];
  };
  readonly engines: readonly string[];
  readonly maxAgeHours: number;
}

interface DbCategoryRow {
  id: string;
  label: string;
  keywords_en: string;
  keywords_fr: string;
  engines: string;
  max_age_hours: number;
  is_active: number;
}

/**
 * Load active categories from an instance DB.
 * Returns empty array if no categories are configured.
 */
export function getCategoriesFromDb(db: SqliteDatabase): readonly InstanceVeilleCategory[] {
  const rows = db.prepare(
    'SELECT id, label, keywords_en, keywords_fr, engines, max_age_hours, is_active FROM veille_categories WHERE is_active = 1 ORDER BY sort_order ASC',
  ).all() as DbCategoryRow[];

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    keywords: {
      en: JSON.parse(row.keywords_en) as string[],
      fr: JSON.parse(row.keywords_fr) as string[],
    },
    engines: JSON.parse(row.engines) as string[],
    maxAgeHours: row.max_age_hours,
    isActive: row.is_active === 1,
  }));
}

export interface SearxngQuery {
  readonly query: string;
  readonly engines: readonly string[];
  readonly language: string;
  readonly category: string;
}

export function buildSearxngQueries(category: VeilleCategory): readonly SearxngQuery[] {
  const queries: SearxngQuery[] = [];

  for (const keyword of category.keywords.en) {
    queries.push({
      query: keyword,
      engines: category.engines,
      language: 'en',
      category: category.id,
    });
  }

  for (const keyword of category.keywords.fr) {
    queries.push({
      query: keyword,
      engines: category.engines,
      language: 'fr',
      category: category.id,
    });
  }

  return queries;
}
