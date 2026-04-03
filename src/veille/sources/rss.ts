import { getLogger } from '../../core/logger.js';
import type { RawArticle } from '../collector.js';

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

/**
 * Collects articles from configured RSS/Atom feeds.
 * Parses XML natively — no external dependency needed.
 */
export async function collectFromRss(
  config: Record<string, unknown>,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const urls = (config['urls'] as string[] | undefined) ?? [];

  if (urls.length === 0) return [];

  const allArticles: RawArticle[] = [];

  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => { controller.abort(); }, 15_000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TumulteBot/1.0)',
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'RSS feed fetch failed');
        continue;
      }

      const xml = await response.text();
      const items = parseRssXml(xml);

      for (const item of items) {
        allArticles.push({
          url: item.link,
          title: item.title,
          snippet: stripHtml(item.description).slice(0, 500),
          source: extractDomain(url),
          language: detectLanguage(item.title, item.description),
          category: 'rss_feed',
          publishedDate: item.pubDate,
        });
      }

      logger.debug({ url, items: items.length }, 'RSS feed parsed');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ url, error: msg }, 'RSS feed collection failed');
    }
  }

  logger.info({ feeds: urls.length, articles: allArticles.length }, 'RSS collection complete');
  return allArticles;
}

/**
 * Basic RSS/Atom XML parser. Extracts items from both RSS 2.0 and Atom formats.
 * Uses regex — good enough for well-formed feeds, no XML parser dependency.
 */
function parseRssXml(xml: string): readonly RssItem[] {
  const items: RssItem[] = [];

  // Try RSS 2.0 format (<item>)
  const rssItemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match = rssItemRegex.exec(xml);

  while (match !== null) {
    const content = match[1] ?? '';
    const title = extractTag(content, 'title');
    const link = extractTag(content, 'link');
    const description = extractTag(content, 'description');
    const pubDate = extractTag(content, 'pubDate');

    if (title.length > 0 && link.length > 0) {
      const item: RssItem = { title, link, description };
      if (pubDate.length > 0) item.pubDate = pubDate;
      items.push(item);
    }

    match = rssItemRegex.exec(xml);
  }

  // Try Atom format (<entry>) if no RSS items found
  if (items.length === 0) {
    const atomEntryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
    let atomMatch = atomEntryRegex.exec(xml);

    while (atomMatch !== null) {
      const content = atomMatch[1] ?? '';
      const title = extractTag(content, 'title');
      const link = extractAtomLink(content);
      const summary = extractTag(content, 'summary') || extractTag(content, 'content');
      const updated = extractTag(content, 'updated') || extractTag(content, 'published');

      if (title.length > 0 && link.length > 0) {
        const item: RssItem = { title, link, description: summary };
        if (updated.length > 0) item.pubDate = updated;
        items.push(item);
      }

      atomMatch = atomEntryRegex.exec(xml);
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  // Handle CDATA
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i');
  const cdataMatch = cdataRegex.exec(xml);
  if (cdataMatch !== null) return (cdataMatch[1] ?? '').trim();

  // Handle normal tags
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = regex.exec(xml);
  return (match?.[1] ?? '').trim();
}

function extractAtomLink(xml: string): string {
  const linkRegex = /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i;
  const match = linkRegex.exec(xml);
  return match?.[1] ?? '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'rss';
  }
}

/**
 * Simple language detection based on French-specific characters and common words.
 */
function detectLanguage(title: string, description: string): string {
  const text = `${title} ${description}`.toLowerCase();
  const frenchIndicators = ['é', 'è', 'ê', 'ë', 'à', 'ù', 'ç', 'ô', 'î', 'û', ' le ', ' la ', ' les ', ' des ', ' du ', ' un ', ' une ', ' et ', ' est ', ' dans ', ' pour ', ' sur ', ' que '];
  const frenchCount = frenchIndicators.filter((indicator) => text.includes(indicator)).length;
  return frenchCount >= 3 ? 'fr' : 'en';
}
