import type { SearxngResult } from '../services/searxng.js';

export interface RawArticle {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
  readonly source: string;
  readonly language: string;
  readonly category: string;
  readonly thumbnailUrl?: string | undefined;
  readonly publishedDate?: string | undefined;
}

export interface CollectorResult {
  readonly articles: readonly RawArticle[];
  readonly stats: CollectorStats;
}

export interface CollectorStats {
  readonly totalFetched: number;
  readonly deduplicated: number;
  readonly filtered: number;
  readonly kept: number;
}

export function resultToArticle(
  result: SearxngResult,
  language: string,
  category: string,
): RawArticle {
  return {
    url: result.url,
    title: result.title,
    snippet: result.content,
    source: result.engine,
    language,
    category,
    thumbnailUrl: result.thumbnail,
    publishedDate: result.publishedDate,
  };
}

export function isWithinMaxAge(publishedDate: string | undefined, maxAgeHours: number): boolean {
  if (publishedDate === undefined) {
    return true;
  }

  // SearXNG sometimes returns relative dates like "5 hours ago" or timestamps
  const published = new Date(publishedDate);
  if (isNaN(published.getTime())) {
    // Unparseable date — assume recent
    return true;
  }

  // Sanity check: if date is in the future or before 2000, it's garbage data
  const now = new Date();
  if (published.getTime() > now.getTime() || published.getFullYear() < 2000) {
    return true;
  }

  const ageHours = (now.getTime() - published.getTime()) / (1000 * 60 * 60);
  // Be generous: allow 2x the max age to avoid filtering too aggressively
  return ageHours <= maxAgeHours * 2;
}
