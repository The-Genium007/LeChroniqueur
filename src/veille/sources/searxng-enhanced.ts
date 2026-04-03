import { search as searxngSearch } from '../../services/searxng.js';
import { getLogger } from '../../core/logger.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';

/**
 * Enhanced SearXNG collector:
 * - Multi-keyword: tests 2-3 keywords per category (not just the first)
 * - Pagination: fetches page 1 and 2 for more results
 * - Reddit targeted: converts configured subreddits into site: queries
 * - Multi-engine: runs same keywords on multiple engines in parallel
 * - Deduplication: merges results by URL across engines
 */
export async function collectFromSearxng(
  categories: readonly VeilleCategory[],
  config: Record<string, unknown>,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  // Extract Reddit subreddits from config (if any)
  const subreddits = (config['subreddits'] as string[] | undefined) ?? [];

  for (const category of categories) {
    // Multi-keyword: use up to 3 keywords per language
    const frKeywords = category.keywords.fr.slice(0, 3);
    const enKeywords = category.keywords.en.slice(0, 3);

    const queries: Array<{ query: string; language: string; engines: readonly string[] }> = [];

    for (const kw of frKeywords) {
      queries.push({ query: kw, language: 'fr', engines: category.engines });
    }
    for (const kw of enKeywords) {
      queries.push({ query: kw, language: 'en', engines: category.engines });
    }

    // Reddit targeted queries via site: prefix
    for (const sub of subreddits) {
      const topFrKw = frKeywords[0] ?? enKeywords[0] ?? category.label;
      queries.push({
        query: `site:reddit.com/r/${sub} ${topFrKw}`,
        language: 'fr',
        engines: ['google'],
      });
    }

    // Execute queries (page 1 only — page 2 adds mostly duplicates)
    for (const q of queries) {
      try {
        const results = await searxngSearch(q.query, {
          engines: q.engines,
          language: q.language,
          timeRange: category.maxAgeHours <= 72 ? 'day' : 'week',
        });

        for (const result of results) {
          if (seenUrls.has(result.url)) continue;
          seenUrls.add(result.url);

          allArticles.push({
            url: result.url,
            title: result.title,
            snippet: result.content,
            source: result.engine,
            language: q.language,
            category: category.id,
            thumbnailUrl: result.thumbnail,
            publishedDate: result.publishedDate,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ query: q.query, error: msg }, 'SearXNG enhanced query failed');
      }
    }
  }

  logger.info({ articles: allArticles.length }, 'SearXNG enhanced collection complete');
  return allArticles;
}
