import type { SqliteDatabase } from './database.js';

// ─── Types ───

export type ScheduleMode = 'daily' | 'weekly';

export interface ScheduleConfig {
  readonly mode: ScheduleMode;
  readonly veilleDay: number | null;
  readonly veilleHour: number;
  readonly publicationDays: readonly number[];
  readonly suggestionsPerCycle: number;
}

interface ScheduleRow {
  mode: string;
  veille_day: number | null;
  veille_hour: number;
  publication_days: string;
  suggestions_per_cycle: number;
}

const DAY_NAMES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'] as const;

// ─── Config CRUD ───

export function getScheduleConfig(db: SqliteDatabase): ScheduleConfig {
  const row = db.prepare('SELECT * FROM schedule_config ORDER BY id LIMIT 1').get() as ScheduleRow | undefined;

  if (row === undefined) {
    return getDefaultConfig();
  }

  return {
    mode: row.mode as ScheduleMode,
    veilleDay: row.veille_day,
    veilleHour: row.veille_hour,
    publicationDays: JSON.parse(row.publication_days) as number[],
    suggestionsPerCycle: row.suggestions_per_cycle,
  };
}

export function getDefaultConfig(): ScheduleConfig {
  return {
    mode: 'daily',
    veilleDay: null,
    veilleHour: 7,
    publicationDays: [1, 2, 3, 4, 5],
    suggestionsPerCycle: 3,
  };
}

export function saveScheduleConfig(db: SqliteDatabase, config: ScheduleConfig): void {
  const existing = db.prepare('SELECT id FROM schedule_config ORDER BY id LIMIT 1').get() as { id: number } | undefined;

  if (existing !== undefined) {
    db.prepare(`
      UPDATE schedule_config SET
        mode = ?, veille_day = ?, veille_hour = ?,
        publication_days = ?, suggestions_per_cycle = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      config.mode,
      config.veilleDay,
      config.veilleHour,
      JSON.stringify(config.publicationDays),
      config.suggestionsPerCycle,
      existing.id,
    );
  } else {
    db.prepare(`
      INSERT INTO schedule_config (mode, veille_day, veille_hour, publication_days, suggestions_per_cycle)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      config.mode,
      config.veilleDay,
      config.veilleHour,
      JSON.stringify(config.publicationDays),
      config.suggestionsPerCycle,
    );
  }
}

// ─── Cron expression builders ───

/**
 * Builds the cron expression for the veille cycle.
 * - Daily mode: runs every day at veilleHour
 * - Weekly mode: runs on veilleDay at veilleHour
 */
export function buildVeilleCron(config: ScheduleConfig): string {
  if (config.mode === 'weekly' && config.veilleDay !== null) {
    return `0 ${String(config.veilleHour)} * * ${String(config.veilleDay)}`;
  }
  return `0 ${String(config.veilleHour)} * * *`;
}

/**
 * Builds the cron expression for the suggestions cycle.
 * - Daily mode: runs every day at veilleHour + 1
 * - Weekly mode: same day as veille, 1 hour after
 */
export function buildSuggestionsCron(config: ScheduleConfig): string {
  const hour = Math.min(config.veilleHour + 1, 23);
  if (config.mode === 'weekly' && config.veilleDay !== null) {
    return `0 ${String(hour)} * * ${String(config.veilleDay)}`;
  }
  return `0 ${String(hour)} * * *`;
}

/**
 * Builds the cron expression for the weekly rapport.
 * Always the day BEFORE the veille day at 20h.
 * - Daily mode: Sunday at 20h (default)
 * - Weekly mode: veilleDay - 1 at 20h
 */
export function buildRapportCron(config: ScheduleConfig): string {
  if (config.mode === 'weekly' && config.veilleDay !== null) {
    const rapportDay = (config.veilleDay + 6) % 7; // Day before veille
    return `0 20 * * ${String(rapportDay)}`;
  }
  return '0 20 * * 0'; // Sunday 20h default
}

// ─── Display helpers ───

export function getDayName(day: number): string {
  return DAY_NAMES[day] ?? 'Inconnu';
}

/**
 * Formats the schedule for display in Discord messages.
 */
export function formatSchedulePreview(config: ScheduleConfig): string {
  const lines: string[] = [];

  if (config.mode === 'weekly' && config.veilleDay !== null) {
    const rapportDay = (config.veilleDay + 6) % 7;
    lines.push(`📊 ${getDayName(rapportDay)} 20h — Rapport hebdo + analytics`);
    lines.push(`📰 ${getDayName(config.veilleDay)} ${String(config.veilleHour)}h — Veille + ${String(config.suggestionsPerCycle)} suggestions`);

    const pubDays = config.publicationDays.map((d) => getDayName(d)).join(', ');
    lines.push(`📱 ${pubDays} — Publications programmées`);
  } else {
    lines.push(`📰 Tous les jours ${String(config.veilleHour)}h — Veille`);
    lines.push(`💡 Tous les jours ${String(config.veilleHour + 1)}h — ${String(config.suggestionsPerCycle)} suggestions`);
    lines.push('📊 Dimanche 20h — Rapport hebdo');
  }

  return lines.join('\n');
}
