import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';

export interface SearxngResult {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly engine: string;
  readonly publishedDate?: string | undefined;
  readonly thumbnail?: string | undefined;
}

export interface SearxngOptions {
  readonly engines?: readonly string[] | undefined;
  readonly language?: string | undefined;
  readonly timeRange?: 'day' | 'week' | 'month' | 'year' | undefined;
  readonly categories?: readonly string[] | undefined;
  readonly pageno?: number | undefined;
}

interface SearxngApiResponse {
  results: Array<{
    url: string;
    title: string;
    content: string;
    engine: string;
    publishedDate?: string;
    thumbnail?: string;
  }>;
  number_of_results: number;
}

const RATE_LIMIT_DELAY_MS = 500;
let lastRequestTime = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;

  if (elapsed < RATE_LIMIT_DELAY_MS) {
    await new Promise((resolve) => {
      setTimeout(resolve, RATE_LIMIT_DELAY_MS - elapsed);
    });
  }

  lastRequestTime = Date.now();
}

export async function search(
  query: string,
  options?: SearxngOptions,
): Promise<readonly SearxngResult[]> {
  const config = getConfig();
  const logger = getLogger();

  if (config.MOCK_APIS) {
    const { MOCK_SEARXNG_RESULTS } = await import('../dev/fixtures.js');
    logger.debug({ query, engines: options?.engines }, 'MOCK SearXNG search');
    return MOCK_SEARXNG_RESULTS;
  }

  await rateLimitWait();

  const params = new URLSearchParams({
    q: query,
    format: 'json',
  });

  if (options?.engines !== undefined && options.engines.length > 0) {
    params.set('engines', options.engines.join(','));
  }

  if (options?.language !== undefined) {
    params.set('language', options.language);
  }

  if (options?.timeRange !== undefined) {
    params.set('time_range', options.timeRange);
  }

  if (options?.categories !== undefined && options.categories.length > 0) {
    params.set('categories', options.categories.join(','));
  }

  if (options?.pageno !== undefined) {
    params.set('pageno', String(options.pageno));
  }

  const url = `${config.SEARXNG_URL}/search?${params.toString()}`;

  logger.debug({ query, engines: options?.engines }, 'SearXNG search');

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`SearXNG returned ${String(response.status)}: ${response.statusText}`);
    }

    const data = (await response.json()) as SearxngApiResponse;

    return data.results.map((r) => ({
      url: r.url,
      title: r.title,
      content: r.content,
      engine: r.engine,
      publishedDate: r.publishedDate,
      thumbnail: r.thumbnail,
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn({ query }, 'SearXNG request timed out');
      return [];
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
