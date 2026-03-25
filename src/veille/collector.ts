import { search as searxngSearch, type SearxngResult } from '../services/searxng.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import {
  getCategories,
  buildSearxngQueries,
  type VeilleCategory,
} from './queries.js';

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

function resultToArticle(
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

function isWithinMaxAge(publishedDate: string | undefined, maxAgeHours: number): boolean {
  if (publishedDate === undefined) {
    // If no date, assume it's recent enough
    return true;
  }

  const published = new Date(publishedDate);
  if (isNaN(published.getTime())) {
    return true;
  }

  const now = new Date();
  const ageHours = (now.getTime() - published.getTime()) / (1000 * 60 * 60);
  return ageHours <= maxAgeHours;
}

export async function collect(
  db: SqliteDatabase,
  categories?: readonly VeilleCategory[],
): Promise<CollectorResult> {
  const logger = getLogger();
  const cats = categories ?? getCategories();

  const allArticles: RawArticle[] = [];
  let totalFetched = 0;

  for (const category of cats) {
    const queries = buildSearxngQueries(category);

    for (const q of queries) {
      try {
        const results = await searxngSearch(q.query, {
          engines: q.engines,
          language: q.language,
          timeRange: category.maxAgeHours <= 72 ? 'day' : 'week',
        });

        totalFetched += results.length;

        for (const result of results) {
          if (isWithinMaxAge(result.publishedDate, category.maxAgeHours)) {
            allArticles.push(resultToArticle(result, q.language, q.category));
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ query: q.query, error: message }, 'SearXNG query failed, skipping');
      }
    }
  }

  // Deduplicate by URL
  const seenUrls = new Set<string>();
  const uniqueArticles: RawArticle[] = [];

  for (const article of allArticles) {
    if (seenUrls.has(article.url)) {
      continue;
    }
    seenUrls.add(article.url);
    uniqueArticles.push(article);
  }

  const deduplicatedInBatch = allArticles.length - uniqueArticles.length;

  // Deduplicate against database (articles already collected)
  const existingUrls = new Set<string>();
  const existingStmt = db.prepare('SELECT url FROM veille_articles WHERE url = ?');

  const newArticles: RawArticle[] = [];

  for (const article of uniqueArticles) {
    const existing = existingStmt.get(article.url) as { url: string } | undefined;
    if (existing !== undefined) {
      existingUrls.add(article.url);
    } else {
      newArticles.push(article);
    }
  }

  const deduplicatedFromDb = existingUrls.size;
  const totalDeduplicated = deduplicatedInBatch + deduplicatedFromDb;

  logger.info(
    {
      totalFetched,
      deduplicated: totalDeduplicated,
      kept: newArticles.length,
    },
    'Veille collection complete',
  );

  return {
    articles: newArticles,
    stats: {
      totalFetched,
      deduplicated: totalDeduplicated,
      filtered: totalFetched - newArticles.length - totalDeduplicated,
      kept: newArticles.length,
    },
  };
}
