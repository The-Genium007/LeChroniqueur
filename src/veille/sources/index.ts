import type { SqliteDatabase } from '../../core/database.js';
import { getLogger } from '../../core/logger.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';
import { collectFromSearxng } from './searxng-enhanced.js';
import { collectFromRss } from './rss.js';
import { collectFromReddit } from './reddit.js';
import { collectFromYouTubeData } from './youtube-data.js';
import { collectFromWebSearch } from './web-search.js';

// ─── Types ───

export type SourceType = 'searxng' | 'rss' | 'reddit' | 'youtube' | 'web_search';

export interface VeilleSourceConfig {
  readonly type: SourceType;
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

export interface MultiSourceResult {
  readonly articles: readonly RawArticle[];
  readonly bySource: ReadonlyMap<string, number>;
  readonly totalFetched: number;
  readonly deduplicated: number;
}

interface SourceRow {
  type: string;
  enabled: number;
  config: string;
}

// ─── Source config CRUD ───

export function getSourceConfigs(db: SqliteDatabase): readonly VeilleSourceConfig[] {
  const rows = db.prepare('SELECT type, enabled, config FROM veille_sources').all() as SourceRow[];

  if (rows.length === 0) {
    return getDefaultSources();
  }

  return rows.map((row) => ({
    type: row.type as SourceType,
    enabled: row.enabled === 1,
    config: JSON.parse(row.config) as Record<string, unknown>,
  }));
}

export function getDefaultSources(): readonly VeilleSourceConfig[] {
  return [
    { type: 'searxng', enabled: true, config: {} },
    { type: 'rss', enabled: false, config: { urls: [] } },
    { type: 'reddit', enabled: false, config: { subreddits: [] } },
    { type: 'youtube', enabled: false, config: { keywords: [], maxResults: 10 } },
    { type: 'web_search', enabled: false, config: {} },
  ];
}

export function upsertSource(db: SqliteDatabase, source: VeilleSourceConfig): void {
  db.prepare(`
    INSERT INTO veille_sources (type, enabled, config)
    VALUES (?, ?, ?)
    ON CONFLICT(type) DO UPDATE SET
      enabled = excluded.enabled,
      config = excluded.config,
      updated_at = CURRENT_TIMESTAMP
  `).run(source.type, source.enabled ? 1 : 0, JSON.stringify(source.config));
}

export function seedDefaultSources(db: SqliteDatabase): void {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM veille_sources').get() as { cnt: number };
  if (count.cnt > 0) return;

  for (const source of getDefaultSources()) {
    upsertSource(db, source);
  }
}

// ─── Multi-source orchestrator ───

/**
 * Collects articles from ALL enabled sources in parallel.
 * Deduplicates by URL across sources.
 */
export async function collectFromAllSources(
  db: SqliteDatabase,
  categories: readonly VeilleCategory[],
): Promise<MultiSourceResult> {
  const logger = getLogger();
  const sources = getSourceConfigs(db);
  const enabledSources = sources.filter((s) => s.enabled);

  logger.info(
    { sources: enabledSources.map((s) => s.type) },
    'Collecting from all enabled sources',
  );

  const results: Array<{ source: string; articles: readonly RawArticle[] }> = [];

  // Run all sources in parallel
  const promises = enabledSources.map(async (source) => {
    try {
      let articles: readonly RawArticle[];

      switch (source.type) {
        case 'searxng':
          articles = await collectFromSearxng(categories, source.config);
          break;
        case 'rss':
          articles = await collectFromRss(source.config);
          break;
        case 'reddit':
          articles = await collectFromReddit(categories, source.config);
          break;
        case 'youtube':
          articles = await collectFromYouTubeData(categories, source.config, db);
          break;
        case 'web_search':
          articles = await collectFromWebSearch(categories, source.config);
          break;
        default:
          articles = [];
      }

      return { source: source.type, articles };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ source: source.type, error: msg }, 'Source collection failed');
      return { source: source.type, articles: [] as readonly RawArticle[] };
    }
  });

  const settled = await Promise.all(promises);
  results.push(...settled);

  // Deduplicate by URL across all sources
  const seenUrls = new Set<string>();
  const allArticles: RawArticle[] = [];
  const bySource = new Map<string, number>();
  let totalFetched = 0;

  for (const result of results) {
    bySource.set(result.source, result.articles.length);
    totalFetched += result.articles.length;

    for (const article of result.articles) {
      if (!seenUrls.has(article.url)) {
        seenUrls.add(article.url);
        allArticles.push(article);
      }
    }
  }

  const deduplicated = totalFetched - allArticles.length;

  logger.info(
    { totalFetched, deduplicated, kept: allArticles.length, sources: Object.fromEntries(bySource) },
    'Multi-source collection complete',
  );

  return { articles: allArticles, bySource, totalFetched, deduplicated };
}
