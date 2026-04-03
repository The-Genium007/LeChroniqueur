import { getLogger } from '../../core/logger.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';

// ─── Rate limiting ───

const RATE_LIMIT_DELAY_MS = 6_000; // 10 req/min = 1 every 6s
const GLOBAL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes max
let lastRedditRequest = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRedditRequest;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((resolve) => {
      setTimeout(resolve, RATE_LIMIT_DELAY_MS - elapsed);
    });
  }
  lastRedditRequest = Date.now();
}

// ─── Types ───

interface RedditPost {
  readonly title: string;
  readonly selftext: string;
  readonly permalink: string;
  readonly url: string;
  readonly score: number;
  readonly num_comments: number;
  readonly created_utc: number;
  readonly stickied: boolean;
  readonly removed_by_category?: string;
  readonly thumbnail: string;
  readonly subreddit: string;
  readonly is_self: boolean;
}

interface RedditListing {
  readonly data: {
    readonly children: ReadonlyArray<{ readonly data: RedditPost }>;
  };
}

// ─── Collector ───

/**
 * Collects trending posts from Reddit using old.reddit.com JSON API.
 * Fetches /hot and /rising for each configured subreddit.
 * All queries are in English — translation happens during LLM analysis.
 */
export async function collectFromReddit(
  categories: readonly VeilleCategory[],
  config: Record<string, unknown>,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const subreddits = (config['subreddits'] as string[] | undefined) ?? [];

  if (subreddits.length === 0) {
    logger.debug('Reddit collector: no subreddits configured');
    return [];
  }

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();
  const startTime = Date.now();
  let totalRequests = 0;

  for (const sub of subreddits) {
    // Global timeout check
    if (Date.now() - startTime > GLOBAL_TIMEOUT_MS) {
      logger.warn({ elapsed: Date.now() - startTime }, 'Reddit collector: global timeout reached');
      break;
    }

    // Fetch /hot and /rising
    for (const endpoint of ['hot', 'rising'] as const) {
      const limit = endpoint === 'hot' ? 25 : 10;

      try {
        await rateLimitWait();
        totalRequests++;

        const url = `https://old.reddit.com/r/${encodeURIComponent(sub)}/${endpoint}.json?limit=${String(limit)}&raw_json=1`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'LeChroniqueur/1.0 (veille bot; +https://github.com)' },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          logger.warn({ sub, endpoint, status: response.status }, 'Reddit fetch failed');
          continue;
        }

        const listing = await response.json() as RedditListing;
        const posts = listing.data.children;

        for (const { data: post } of posts) {
          // Filter noise
          if (post.stickied) continue;
          if (post.score < 5) continue;
          if (post.removed_by_category !== undefined) continue;

          const postUrl = `https://reddit.com${post.permalink}`;
          if (seenUrls.has(postUrl)) continue;
          seenUrls.add(postUrl);

          const snippet = post.is_self
            ? post.selftext.slice(0, 500)
            : post.url !== postUrl ? `[Link: ${post.url}] ${post.selftext.slice(0, 300)}` : '';

          allArticles.push({
            url: postUrl,
            title: post.title,
            snippet,
            source: `reddit/r/${post.subreddit}`,
            language: 'en',
            category: matchCategory(post.title, categories),
            thumbnailUrl: isValidThumbnail(post.thumbnail) ? post.thumbnail : undefined,
            publishedDate: new Date(post.created_utc * 1000).toISOString(),
          });
        }

        logger.debug({ sub, endpoint, posts: posts.length }, 'Reddit endpoint fetched');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn({ sub, endpoint, error: msg }, 'Reddit endpoint error');
      }
    }
  }

  logger.info(
    { subreddits: subreddits.length, requests: totalRequests, articles: allArticles.length },
    'Reddit collection complete',
  );

  return allArticles;
}

// ─── Helpers ───

function isValidThumbnail(thumb: string): boolean {
  return thumb.startsWith('http') && !['self', 'default', 'nsfw', 'spoiler', 'image'].includes(thumb);
}

/**
 * Match a post title to the best category based on English keywords.
 * Falls back to 'reddit' if no match found.
 */
function matchCategory(title: string, categories: readonly VeilleCategory[]): string {
  const lower = title.toLowerCase();

  for (const cat of categories) {
    for (const kw of cat.keywords.en) {
      if (lower.includes(kw.toLowerCase())) {
        return cat.id;
      }
    }
  }

  return 'reddit';
}
