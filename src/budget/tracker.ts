import type { SqliteDatabase } from '../core/database.js';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { computeLlmCostCents as computeProviderCost } from '../services/llm-providers.js';
import { getLlmConfig } from '../services/llm-factory.js';

export interface BudgetPeriod {
  readonly anthropicCents: number;
  readonly googleCents: number;
  readonly totalCents: number;
  readonly budgetCents: number;
  readonly percentUsed: number;
}

export interface BudgetAlert {
  readonly period: 'daily' | 'weekly' | 'monthly';
  readonly thresholdPercent: number;
  readonly costCents: number;
  readonly budgetCents: number;
}

function todayDateStr(): string {
  return new Date().toISOString().split('T')[0] ?? '';
}

function ensureTodayRow(db: SqliteDatabase): void {
  const today = todayDateStr();
  db.prepare(`
    INSERT OR IGNORE INTO metrics (date) VALUES (?)
  `).run(today);
}

// ─── Cost calculations ───

export function computeAnthropicCostCents(tokensIn: number, tokensOut: number): number {
  const inputCost = (tokensIn / 1_000_000) * 300;
  const outputCost = (tokensOut / 1_000_000) * 1500;
  return Math.ceil(inputCost + outputCost);
}

export function computeGoogleImageCostCents(count: number): number {
  return Math.ceil(count * 3);
}

export function computeGoogleVideoCostCents(seconds: number): number {
  return Math.ceil(seconds * 38);
}

// ─── Recording ───

export function recordAnthropicUsage(
  db: SqliteDatabase,
  tokensIn: number,
  tokensOut: number,
): void {
  ensureTodayRow(db);
  const costCents = computeAnthropicCostCents(tokensIn, tokensOut);

  db.prepare(`
    UPDATE metrics SET
      anthropic_tokens_in = anthropic_tokens_in + ?,
      anthropic_tokens_out = anthropic_tokens_out + ?,
      anthropic_cost_cents = anthropic_cost_cents + ?
    WHERE date = ?
  `).run(tokensIn, tokensOut, costCents, todayDateStr());
}

export function recordGoogleImageUsage(db: SqliteDatabase, count: number): void {
  ensureTodayRow(db);
  const costCents = computeGoogleImageCostCents(count);

  db.prepare(`
    UPDATE metrics SET
      google_image_count = google_image_count + ?,
      google_cost_cents = google_cost_cents + ?
    WHERE date = ?
  `).run(count, costCents, todayDateStr());
}

export function recordGoogleVideoUsage(db: SqliteDatabase, seconds: number): void {
  ensureTodayRow(db);
  const costCents = computeGoogleVideoCostCents(seconds);

  db.prepare(`
    UPDATE metrics SET
      google_video_seconds = google_video_seconds + ?,
      google_cost_cents = google_cost_cents + ?
    WHERE date = ?
  `).run(seconds, costCents, todayDateStr());
}

export function recordSearxngQuery(db: SqliteDatabase, count: number): void {
  ensureTodayRow(db);
  db.prepare(`
    UPDATE metrics SET searxng_queries = searxng_queries + ? WHERE date = ?
  `).run(count, todayDateStr());
}

// ─── Period totals ───

function getMetricsForRange(
  db: SqliteDatabase,
  startDate: string,
  endDate: string,
): { anthropicCents: number; googleCents: number } {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(anthropic_cost_cents), 0) AS anthropicCents,
      COALESCE(SUM(google_cost_cents), 0) AS googleCents
    FROM metrics
    WHERE date >= ? AND date <= ?
  `).get(startDate, endDate) as { anthropicCents: number; googleCents: number };

  return row;
}

export function getDailyTotal(db: SqliteDatabase): BudgetPeriod {
  const config = getConfig();
  const today = todayDateStr();
  const { anthropicCents, googleCents } = getMetricsForRange(db, today, today);
  const totalCents = anthropicCents + googleCents;

  return {
    anthropicCents,
    googleCents,
    totalCents,
    budgetCents: config.BUDGET_DAILY_CENTS,
    percentUsed: config.BUDGET_DAILY_CENTS > 0
      ? Math.round((totalCents / config.BUDGET_DAILY_CENTS) * 100)
      : 0,
  };
}

export function getWeeklyTotal(db: SqliteDatabase): BudgetPeriod {
  const config = getConfig();
  const now = new Date();
  const dayOfWeek = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
  const startDate = monday.toISOString().split('T')[0] ?? '';
  const endDate = todayDateStr();

  const { anthropicCents, googleCents } = getMetricsForRange(db, startDate, endDate);
  const totalCents = anthropicCents + googleCents;

  return {
    anthropicCents,
    googleCents,
    totalCents,
    budgetCents: config.BUDGET_WEEKLY_CENTS,
    percentUsed: config.BUDGET_WEEKLY_CENTS > 0
      ? Math.round((totalCents / config.BUDGET_WEEKLY_CENTS) * 100)
      : 0,
  };
}

export function getMonthlyTotal(db: SqliteDatabase): BudgetPeriod {
  const config = getConfig();
  const now = new Date();
  const startDate = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const endDate = todayDateStr();

  const { anthropicCents, googleCents } = getMetricsForRange(db, startDate, endDate);
  const totalCents = anthropicCents + googleCents;

  return {
    anthropicCents,
    googleCents,
    totalCents,
    budgetCents: config.BUDGET_MONTHLY_CENTS,
    percentUsed: config.BUDGET_MONTHLY_CENTS > 0
      ? Math.round((totalCents / config.BUDGET_MONTHLY_CENTS) * 100)
      : 0,
  };
}

// ─── Threshold checks ───

export function checkThresholds(db: SqliteDatabase): readonly BudgetAlert[] {
  const logger = getLogger();
  const alerts: BudgetAlert[] = [];

  const periods = [
    { name: 'daily' as const, getter: getDailyTotal },
    { name: 'weekly' as const, getter: getWeeklyTotal },
    { name: 'monthly' as const, getter: getMonthlyTotal },
  ];

  for (const period of periods) {
    const total = period.getter(db);

    if (total.percentUsed >= 80) {
      // Check if we already alerted today for this period+threshold
      const today = todayDateStr();
      const threshold = total.percentUsed >= 100 ? 100 : 80;

      const existing = db.prepare(`
        SELECT id FROM budget_alerts
        WHERE period = ? AND threshold_percent = ? AND DATE(triggered_at) = ?
      `).get(period.name, threshold, today) as { id: number } | undefined;

      if (existing === undefined) {
        alerts.push({
          period: period.name,
          thresholdPercent: threshold,
          costCents: total.totalCents,
          budgetCents: total.budgetCents,
        });

        db.prepare(`
          INSERT INTO budget_alerts (period, threshold_percent, cost_cents, budget_cents)
          VALUES (?, ?, ?, ?)
        `).run(period.name, threshold, total.totalCents, total.budgetCents);

        logger.warn(
          { period: period.name, percent: total.percentUsed },
          'Budget threshold reached',
        );
      }
    }
  }

  return alerts;
}

export function isApiAllowed(db: SqliteDatabase): boolean {
  const monthly = getMonthlyTotal(db);
  return monthly.percentUsed < 100;
}

// ─── Multi-provider LLM cost tracking ───

/**
 * Records LLM usage with provider-aware cost calculation.
 * Also updates legacy anthropic columns for backward compatibility.
 */
export function recordLlmUsage(
  db: SqliteDatabase,
  tokensIn: number,
  tokensOut: number,
): void {
  const llmConfig = getLlmConfig();
  const provider = llmConfig?.provider ?? 'anthropic';
  const model = llmConfig?.model ?? 'claude-sonnet-4-6';
  const costCents = computeProviderCost(provider, model, tokensIn, tokensOut);

  ensureTodayRow(db);

  // Update LLM-specific columns
  db.prepare(`
    UPDATE metrics SET
      llm_cost_cents = llm_cost_cents + ?,
      llm_provider = ?,
      llm_model = ?
    WHERE date = ?
  `).run(costCents, provider, model, todayDateStr());

  // Backward compat: also update anthropic columns
  db.prepare(`
    UPDATE metrics SET
      anthropic_tokens_in = anthropic_tokens_in + ?,
      anthropic_tokens_out = anthropic_tokens_out + ?,
      anthropic_cost_cents = anthropic_cost_cents + ?
    WHERE date = ?
  `).run(tokensIn, tokensOut, costCents, todayDateStr());
}
