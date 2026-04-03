import { search as searxngSearch } from '../../services/searxng.js';
import { getLogger } from '../../core/logger.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';

/**
 * Collects articles from YouTube by:
 * 1. Searching YouTube via SearXNG (engines: ['youtube'])
 * 2. Attempting to fetch transcripts via youtube-transcript API
 * 3. Falling back to title + description if transcript unavailable
 */
export async function collectFromYouTube(
  categories: readonly VeilleCategory[],
  config: Record<string, unknown>,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const maxResults = (config['maxResults'] as number | undefined) ?? 10;
  const customKeywords = (config['keywords'] as string[] | undefined) ?? [];

  const allArticles: RawArticle[] = [];
  const seenUrls = new Set<string>();

  // Build search queries from categories + custom keywords
  const queries: string[] = [];

  for (const cat of categories) {
    const topKw = cat.keywords.fr[0] ?? cat.keywords.en[0];
    if (topKw !== undefined) {
      queries.push(topKw);
    }
  }

  queries.push(...customKeywords);

  // Search YouTube via SearXNG
  for (const query of queries.slice(0, 8)) {
    try {
      const results = await searxngSearch(query, {
        engines: ['youtube'],
        language: 'fr',
        timeRange: 'week',
      });

      for (const result of results.slice(0, maxResults)) {
        if (seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);

        // Try to fetch transcript
        let transcript: string | undefined;
        const videoId = extractYouTubeVideoId(result.url);

        if (videoId !== undefined) {
          transcript = await fetchTranscript(videoId);
        }

        const snippet = transcript !== undefined
          ? `[Transcription] ${transcript.slice(0, 800)}`
          : result.content;

        allArticles.push({
          url: result.url,
          title: result.title,
          snippet,
          source: 'youtube',
          language: 'fr',
          category: 'youtube',
          thumbnailUrl: result.thumbnail,
          publishedDate: result.publishedDate,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ query, error: msg }, 'YouTube search failed');
    }
  }

  logger.info({ queries: queries.length, articles: allArticles.length }, 'YouTube collection complete');
  return allArticles;
}

/**
 * Extracts YouTube video ID from URL.
 */
function extractYouTubeVideoId(url: string): string | undefined {
  try {
    const parsed = new URL(url);

    // youtube.com/watch?v=VIDEO_ID
    if (parsed.hostname.includes('youtube.com')) {
      return parsed.searchParams.get('v') ?? undefined;
    }

    // youtu.be/VIDEO_ID
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.slice(1) || undefined;
    }
  } catch {
    // Invalid URL
  }
  return undefined;
}

// Cache the youtube-transcript module import result
let ytFetchTranscript: ((id: string) => Promise<Array<{ text: string }>>) | null | undefined;

/**
 * Fetches YouTube transcript using the youtube-transcript API.
 * Falls back gracefully if unavailable.
 */
async function fetchTranscript(videoId: string): Promise<string | undefined> {
  const logger = getLogger();

  // Only try to load the module once
  if (ytFetchTranscript === undefined) {
    try {
      // The youtube-transcript package has a broken ESM/CJS setup.
      // Import the ESM bundle directly to avoid the resolution issue.
      const mod = await import('youtube-transcript/dist/youtube-transcript.esm.js');
      ytFetchTranscript = mod.fetchTranscript ?? mod.YoutubeTranscript?.fetchTranscript ?? null;
    } catch {
      logger.warn('youtube-transcript module not available');
      ytFetchTranscript = null;
    }
  }

  if (ytFetchTranscript === null) {
    return undefined;
  }

  try {
    const transcript = await ytFetchTranscript(videoId);
    const text = transcript.map((entry) => entry.text).join(' ');

    if (text.length > 0) {
      logger.debug({ videoId, length: text.length }, 'YouTube transcript fetched');
      return text;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug({ videoId, error: msg }, 'YouTube transcript unavailable (fallback to snippet)');
  }

  return undefined;
}
