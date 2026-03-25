import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/core/migrations/index.js';
import {
  computeAnthropicCostCents,
  computeGoogleImageCostCents,
  computeGoogleVideoCostCents,
} from '../../src/budget/tracker.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('cost calculations', () => {
  it('should compute Anthropic costs correctly', () => {
    // 1M input tokens = $3 = 300 cents
    expect(computeAnthropicCostCents(1_000_000, 0)).toBe(300);

    // 1M output tokens = $15 = 1500 cents
    expect(computeAnthropicCostCents(0, 1_000_000)).toBe(1500);

    // Mixed
    expect(computeAnthropicCostCents(500_000, 200_000)).toBe(
      Math.ceil((500_000 / 1_000_000) * 300 + (200_000 / 1_000_000) * 1500),
    );
  });

  it('should compute Google image costs correctly', () => {
    // 1 image = ~3 cents
    expect(computeGoogleImageCostCents(1)).toBe(3);

    // 10 images = 30 cents
    expect(computeGoogleImageCostCents(10)).toBe(30);
  });

  it('should compute Google video costs correctly', () => {
    // 1 second = ~38 cents
    expect(computeGoogleVideoCostCents(1)).toBe(38);

    // 6 seconds = 228 cents
    expect(computeGoogleVideoCostCents(6)).toBe(228);
  });

  it('should round up fractional costs', () => {
    // Small number of tokens should still cost at least 1 cent
    expect(computeAnthropicCostCents(100, 100)).toBeGreaterThanOrEqual(1);
  });
});

describe('metrics table', () => {
  it('should insert and query daily metrics', () => {
    const today = new Date().toISOString().split('T')[0] ?? '';

    db.prepare('INSERT INTO metrics (date, anthropic_cost_cents, google_cost_cents) VALUES (?, ?, ?)')
      .run(today, 150, 38);

    const row = db.prepare('SELECT * FROM metrics WHERE date = ?').get(today) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row['anthropic_cost_cents']).toBe(150);
    expect(row['google_cost_cents']).toBe(38);
  });

  it('should enforce unique date constraint', () => {
    db.prepare('INSERT INTO metrics (date) VALUES (?)').run('2026-03-25');

    expect(() => {
      db.prepare('INSERT INTO metrics (date) VALUES (?)').run('2026-03-25');
    }).toThrow();
  });
});

describe('budget_alerts table', () => {
  it('should record alerts', () => {
    db.prepare(`
      INSERT INTO budget_alerts (period, threshold_percent, cost_cents, budget_cents)
      VALUES (?, ?, ?, ?)
    `).run('daily', 80, 240, 300);

    const alert = db.prepare('SELECT * FROM budget_alerts').get() as Record<string, unknown>;

    expect(alert).toBeDefined();
    expect(alert['period']).toBe('daily');
    expect(alert['threshold_percent']).toBe(80);
  });
});
