import { search as searxngSearch } from '../../services/searxng.js';
import { getLogger } from '../../core/logger.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';

/**
 * Enhanced SearXNG collector:
 * - English-only queries (translation happens during LLM analysis)
 * - Multi-keyword: tests up to 3 EN keywords per category
 * - Excludes reddit.com and youtube.com URLs (handled by native collectors)
 * - Multi-engine: runs same keywords on multiple engines
 * - Deduplication: merges results by URL across engines
 */
export async function collectFromSearxng(
  categories: readonly VeilleCategory[],
  _config: Record<string, unknown>,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  for (const category of categories) {
    // English-only: use up to 3 EN keywords
    const enKeywords = category.keywords.en.slice(0, 3);

    // Use sane SearXNG engines — ignore category.engines (may contain invalid ones like twitter, reddit, imgur)
    // Reddit and YouTube are handled by native collectors
    const engines = ['google', 'bing', 'duckduckgo'];

    for (const kw of enKeywords) {
      try {
        const results = await searxngSearch(kw, {
          engines,
          language: 'en',
          timeRange: category.maxAgeHours <= 72 ? 'day' : 'week',
        });

        for (const result of results) {
          if (seenUrls.has(result.url)) continue;

          // Skip Reddit and YouTube URLs — handled by native collectors
          if (result.url.includes('reddit.com/') || result.url.includes('youtube.com/') || result.url.includes('youtu.be/')) {
            continue;
          }

          seenUrls.add(result.url);

          allArticles.push({
            url: result.url,
            title: result.title,
            snippet: result.content,
            source: result.engine,
            language: 'en',
            category: category.id,
            thumbnailUrl: result.thumbnail,
            publishedDate: result.publishedDate,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ query: kw, error: msg }, 'SearXNG query failed');
      }
    }
  }

  logger.info({ articles: allArticles.length }, 'SearXNG collection complete');
  return allArticles;
}
