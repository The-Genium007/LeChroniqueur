import { describe, it, expect } from 'vitest';
import {
  getActiveSeasons,
  getUpcomingSeasons,
  formatSeasonalContext,
} from '../../src/analytics/seasonality.js';

describe('getActiveSeasons', () => {
  it('should detect Christmas season in late December', () => {
    const date = new Date(2025, 11, 20); // Dec 20
    const seasons = getActiveSeasons(date);

    expect(seasons.some((s) => s.name === 'Noël')).toBe(true);
  });

  it('should detect Christmas season in early January (cross-year)', () => {
    const date = new Date(2026, 0, 3); // Jan 3
    const seasons = getActiveSeasons(date);

    expect(seasons.some((s) => s.name === 'Noël')).toBe(true);
  });

  it('should detect Halloween in late October', () => {
    const date = new Date(2025, 9, 25); // Oct 25
    const seasons = getActiveSeasons(date);

    expect(seasons.some((s) => s.name === 'Halloween')).toBe(true);
  });

  it('should return empty for a quiet period', () => {
    const date = new Date(2025, 4, 15); // May 15
    const seasons = getActiveSeasons(date);

    // May is generally quiet (no major event defined)
    expect(seasons).toHaveLength(0);
  });

  it('should detect rentrée in early September', () => {
    const date = new Date(2025, 8, 5); // Sep 5
    const seasons = getActiveSeasons(date);

    expect(seasons.some((s) => s.name === 'Rentrée')).toBe(true);
  });

  it('should detect Black Friday in late November', () => {
    const date = new Date(2025, 10, 25); // Nov 25
    const seasons = getActiveSeasons(date);

    expect(seasons.some((s) => s.name === 'Black Friday')).toBe(true);
  });
});

describe('getUpcomingSeasons', () => {
  it('should find upcoming events within 14 days', () => {
    const date = new Date(2025, 9, 15); // Oct 15 — Halloween starts Oct 20
    const upcoming = getUpcomingSeasons(date, 14);

    expect(upcoming.some((s) => s.name === 'Halloween')).toBe(true);
  });

  it('should not find distant events', () => {
    const date = new Date(2025, 4, 1); // May 1 — nothing close
    const upcoming = getUpcomingSeasons(date, 14);

    expect(upcoming).toHaveLength(0);
  });

  it('should include currently active events', () => {
    const date = new Date(2025, 11, 25); // Dec 25 — Christmas active
    const upcoming = getUpcomingSeasons(date, 14);

    expect(upcoming.some((s) => s.name === 'Noël')).toBe(true);
  });

  it('should not duplicate events', () => {
    const date = new Date(2025, 11, 20); // Dec 20 — Christmas active for multiple days
    const upcoming = getUpcomingSeasons(date, 14);

    const christmasCount = upcoming.filter((s) => s.name === 'Noël').length;
    expect(christmasCount).toBe(1);
  });
});

describe('formatSeasonalContext', () => {
  it('should format active seasons', () => {
    const date = new Date(2025, 11, 25);
    const context = formatSeasonalContext(date);

    expect(context).toContain('EN COURS');
    expect(context).toContain('Noël');
  });

  it('should indicate no events when quiet', () => {
    const date = new Date(2025, 4, 15);
    const context = formatSeasonalContext(date);

    expect(context).toContain("Pas d'événement saisonnier");
  });
});
