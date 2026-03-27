import { z } from 'zod';
import type { SqliteDatabase } from '../core/database.js';
import { personaLoader } from '../core/persona-loader.js';
import { getLogger } from '../core/logger.js';

// ─── Validation Schema ───

export const ImportSchema = z.object({
  instanceName: z.string().min(1),
  persona: z.string(),
  categories: z.array(z.object({
    id: z.string(),
    label: z.string(),
    keywords_en: z.string(),
    keywords_fr: z.string(),
    engines: z.string(),
    max_age_hours: z.number(),
    is_active: z.number(),
    sort_order: z.number(),
  })),
  configOverrides: z.array(z.object({
    key: z.string(),
    value: z.string(),
  })),
});

export type ImportData = z.infer<typeof ImportSchema>;

// ─── Apply import to existing instance DB ───

export function applyImportToInstance(
  instanceId: string,
  instanceDb: SqliteDatabase,
  data: ImportData,
): void {
  const logger = getLogger();

  instanceDb.transaction(() => {
    // Replace categories
    instanceDb.prepare('DELETE FROM veille_categories').run();
    const insertCat = instanceDb.prepare(`
      INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines, max_age_hours, is_active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cat of data.categories) {
      insertCat.run(cat.id, cat.label, cat.keywords_en, cat.keywords_fr, cat.engines, cat.max_age_hours, cat.is_active, cat.sort_order);
    }

    // Replace config overrides
    instanceDb.prepare('DELETE FROM config_overrides').run();
    const insertOverride = instanceDb.prepare(`
      INSERT INTO config_overrides (key, value, updated_at, updated_by)
      VALUES (?, ?, datetime('now'), 'import')
    `);
    for (const override of data.configOverrides) {
      insertOverride.run(override.key, override.value);
    }

    // Upsert persona
    if (data.persona.length > 0) {
      personaLoader.saveForInstance(instanceId, instanceDb, data.persona);
    }
  })();

  logger.info({ instanceId, categories: data.categories.length, overrides: data.configOverrides.length }, 'Import applied');
}

// ─── Parse and validate import file ───

export function parseImportFile(content: string): ImportData {
  const json: unknown = JSON.parse(content);
  return ImportSchema.parse(json);
}
