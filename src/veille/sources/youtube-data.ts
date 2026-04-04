import { getLogger } from '../../core/logger.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';
import type { SqliteDatabase } from '../../core/database.js';

// ─── YouTube Data API v3 constants ───

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const SEARCH_QUOTA_COST = 100; // units per search.list call
const DEFAULT_QUOTA_BUDGET = 5_000; // daily budget (half of 10k free tier)
const RATE_LIMIT_DELAY_MS = 200; // light rate limiting between calls
let lastYouTubeRequest = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastYouTubeRequest;
  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((resolve) => {
      setTimeout(resolve, RATE_LIMIT_DELAY_MS - elapsed);
    });
  }
  lastYouTubeRequest = Date.now();
}

// ─── Types ───

interface YouTubeSearchItem {
  readonly id: { readonly videoId: string };
  readonly snippet: {
    readonly title: string;
    readonly description: string;
    readonly publishedAt: string;
    readonly thumbnails: {
      readonly medium?: { readonly url: string };
      readonly default?: { readonly url: string };
    };
    readonly channelTitle: string;
  };
}

interface YouTubeSearchResponse {
  readonly items: readonly YouTubeSearchItem[];
  readonly pageInfo: { readonly totalResults: number };
  readonly error?: { readonly message: string; readonly code: number };
}

// ─── Quota tracking ───

function getTodayQuotaUsage(db: SqliteDatabase): number {
  const today = new Date().toISOString().split('T')[0] ?? '';
  const row = db.prepare(
    'SELECT COALESCE(youtube_quota_units, 0) AS units FROM metrics WHERE date = ?',
  ).get(today) as { units: number } | undefined;
  return row?.units ?? 0;
}

function getQuotaBudget(db: SqliteDatabase): number {
  const row = db.prepare(
    "SELECT value FROM config_overrides WHERE key = 'youtubeQuotaBudget'",
  ).get() as { value: string } | undefined;
  return row !== undefined ? Number(row.value) : DEFAULT_QUOTA_BUDGET;
}

// ─── Collector ───

/**
 * Collects videos from YouTube using the Data API v3.
 * Uses the Google Cloud API key (same key as Generative AI if both APIs are enabled).
 * All queries are in English — translation happens during LLM analysis.
 *
 * After collecting video metadata, attempts to fetch transcripts using youtube-transcript.
 */
export async function collectFromYouTubeData(
  categories: readonly VeilleCategory[],
  config: Record<string, unknown>,
  db: SqliteDatabase,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const apiKey = process.env['GOOGLE_CLOUD_API_KEY'];

  if (apiKey === undefined || apiKey.length === 0) {
    logger.warn('YouTube Data collector: no Google Cloud API key configured');
    return [];
  }

  const maxResults = (config['maxResults'] as number | undefined) ?? 10;
  const customKeywords = (config['keywords'] as string[] | undefined) ?? [];

  // Build keyword list from categories (English only) + custom keywords
  const keywords: string[] = [];
  for (const cat of categories) {
    for (const kw of cat.keywords.en.slice(0, 2)) {
      keywords.push(kw);
    }
  }
  keywords.push(...customKeywords);

  // Deduplicate keywords
  const uniqueKeywords = [...new Set(keywords)].slice(0, 20);

  if (uniqueKeywords.length === 0) {
    logger.debug('YouTube Data collector: no keywords');
    return [];
  }

  // Quota check
  const usedToday = getTodayQuotaUsage(db);
  const budget = getQuotaBudget(db);
  const maxSearches = Math.floor((budget - usedToday) / SEARCH_QUOTA_COST);

  if (maxSearches <= 0) {
    logger.warn({ usedToday, budget }, 'YouTube Data collector: daily quota budget exhausted');
    return [];
  }

  const searchCount = Math.min(uniqueKeywords.length, maxSearches);
  logger.info(
    { keywords: searchCount, quotaUsed: usedToday, quotaBudget: budget },
    'YouTube Data collector starting',
  );

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();
  let quotaUsed = 0;

  for (const keyword of uniqueKeywords.slice(0, searchCount)) {
    try {
      await rateLimitWait();

      const params = new URLSearchParams({
        part: 'snippet',
        q: keyword,
        type: 'video',
        order: 'date',
        maxResults: String(Math.min(maxResults, 25)),
        relevanceLanguage: 'en',
        key: apiKey,
      });

      const response = await fetch(`${YOUTUBE_API_BASE}/search?${params.toString()}`, {
        signal: AbortSignal.timeout(15_000),
      });

      quotaUsed += SEARCH_QUOTA_COST;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 403 && text.includes('quotaExceeded')) {
          logger.warn('YouTube Data API: daily quota exceeded, stopping');
          break;
        }
        if (response.status === 403 && text.includes('accessNotConfigured')) {
          logger.error('YouTube Data API not enabled on this Google Cloud project. Enable it at: https://console.cloud.google.com/apis/library/youtube.googleapis.com');
          break;
        }
        logger.warn({ keyword, status: response.status }, 'YouTube search failed');
        continue;
      }

      const data = await response.json() as YouTubeSearchResponse;

      if (data.error !== undefined) {
        logger.warn({ keyword, error: data.error.message }, 'YouTube API error');
        continue;
      }

      for (const item of data.items) {
        const videoUrl = `https://youtube.com/watch?v=${item.id.videoId}`;
        if (seenUrls.has(videoUrl)) continue;
        seenUrls.add(videoUrl);

        allArticles.push({
          url: videoUrl,
          title: item.snippet.title,
          snippet: item.snippet.description.slice(0, 500),
          source: `youtube/${item.snippet.channelTitle}`,
          language: 'en',
          category: matchCategory(keyword, categories),
          thumbnailUrl: item.snippet.thumbnails.medium?.url ?? item.snippet.thumbnails.default?.url,
          publishedDate: item.snippet.publishedAt,
        });
      }

      logger.debug({ keyword, results: data.items.length }, 'YouTube search complete');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ keyword, error: msg }, 'YouTube search error');
    }
  }

  // Record quota usage
  if (quotaUsed > 0) {
    try {
      const { recordYouTubeUsage } = await import('../../budget/tracker.js');
      recordYouTubeUsage(db, quotaUsed);
    } catch {
      logger.debug('Could not record YouTube quota usage');
    }
  }

  // Enrich with transcripts (best-effort, non-blocking)
  await enrichWithTranscripts(allArticles, logger);

  logger.info(
    { keywords: searchCount, quotaUsed, articles: allArticles.length },
    'YouTube Data collection complete',
  );

  return allArticles;
}

// ─── Transcript enrichment ───

// Reuse the cached transcript module from youtube-transcript.ts
let ytFetchTranscript: ((id: string) => Promise<Array<{ text: string }>>) | null | undefined;

async function enrichWithTranscripts(
  articles: RawArticle[],
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  // Load module once
  if (ytFetchTranscript === undefined) {
    try {
      const mod = await import('youtube-transcript/dist/youtube-transcript.esm.js');
      ytFetchTranscript = mod.fetchTranscript ?? mod.YoutubeTranscript?.fetchTranscript ?? null;
    } catch {
      logger.debug('youtube-transcript module not available, skipping transcript enrichment');
      ytFetchTranscript = null;
    }
  }

  if (ytFetchTranscript === null || ytFetchTranscript === undefined) return;
  const fetchFn = ytFetchTranscript;

  for (const article of articles) {
    const videoId = extractVideoId(article.url);
    if (videoId === undefined) continue;

    try {
      const transcript = await fetchFn(videoId);
      const text = transcript.map((entry) => entry.text).join(' ');

      if (text.length > 0) {
        // Mutate snippet to include transcript (cast to mutable)
        (article as { snippet: string }).snippet = `[Transcription] ${text.slice(0, 800)}`;
        logger.debug({ videoId }, 'Transcript enriched');
      }
    } catch {
      // Transcript unavailable — keep original snippet
    }
  }
}

function extractVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v') ?? undefined;
    }
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.slice(1) || undefined;
    }
  } catch { /* invalid URL */ }
  return undefined;
}

function matchCategory(keyword: string, categories: readonly VeilleCategory[]): string {
  const lower = keyword.toLowerCase();
  for (const cat of categories) {
    for (const kw of cat.keywords.en) {
      if (lower.includes(kw.toLowerCase()) || kw.toLowerCase().includes(lower)) {
        return cat.id;
      }
    }
  }
  return 'youtube';
}
