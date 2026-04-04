import type { SqliteDatabase } from '../core/database.js';
import type { InstanceProfile } from '../core/instance-profile.js';
import type { VeilleCategory } from './queries.js';
import type { RawArticle } from './collector.js';
import { getLogger } from '../core/logger.js';

// ─── Types ───

export interface PrefilterResult {
  readonly passed: readonly RawArticle[];
  readonly stats: PrefilterStats;
}

export interface PrefilterStats {
  readonly input: number;
  readonly afterDbDedup: number;
  readonly afterUrlFilter: number;
  readonly afterContentFilter: number;
  readonly afterNearDedup: number;
  readonly afterTitleRelevance: number;
  readonly rejectedByReason: Record<string, number>;
}

// ─── URL noise patterns ───

const NOISE_URL_PATTERNS: readonly RegExp[] = [
  // Social profile pages (no content)
  /^https?:\/\/(www\.)?twitch\.tv\/[^/]+\/?$/,
  /^https?:\/\/(www\.)?twitch\.tv\/directory\//,
  /^https?:\/\/(www\.)?linkedin\.com\/in\//,
  /^https?:\/\/(www\.)?linkedin\.com\/jobs\//,

  // Index / tag / search pages
  /\/tag\/[^/]+\/?$/,
  /\/category\/[^/]+\/?$/,
  /\/search\?/,
  /\/author\/[^/]+\/?$/,

  // Stats / changelog pages
  /steamcharts\.com/,
  /\/changelog$/i,

  // URL shorteners
  /^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl)\//,
];

// ─── Filter 0: DB dedup ───

function filterDbDedup(
  articles: readonly RawArticle[],
  db: SqliteDatabase | undefined,
  reasons: Record<string, number>,
): readonly RawArticle[] {
  if (db === undefined) return articles;

  const stmt = db.prepare('SELECT url FROM veille_articles WHERE url = ?');
  const passed: RawArticle[] = [];

  for (const article of articles) {
    const existing = stmt.get(article.url) as { url: string } | undefined;
    if (existing !== undefined) {
      reasons['already_in_db'] = (reasons['already_in_db'] ?? 0) + 1;
    } else {
      passed.push(article);
    }
  }

  return passed;
}

// ─── Filter 1: URL patterns ───

function isExcludedDomain(url: string, excludeDomains: readonly string[]): string | undefined {
  if (excludeDomains.length === 0) return undefined;

  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    for (const domain of excludeDomains) {
      const normalizedDomain = domain.replace(/^www\./, '');
      if (hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)) {
        return domain;
      }
    }
  } catch {
    // Invalid URL
  }
  return undefined;
}

function filterUrlPatterns(
  articles: readonly RawArticle[],
  excludeDomains: readonly string[],
  reasons: Record<string, number>,
): readonly RawArticle[] {
  const passed: RawArticle[] = [];

  for (const article of articles) {
    // Check noise patterns
    const matchedPattern = NOISE_URL_PATTERNS.some((pattern) => pattern.test(article.url));
    if (matchedPattern) {
      reasons['noise_url_pattern'] = (reasons['noise_url_pattern'] ?? 0) + 1;
      continue;
    }

    // Check excluded domains
    const excludedDomain = isExcludedDomain(article.url, excludeDomains);
    if (excludedDomain !== undefined) {
      const key = `excluded_domain:${excludedDomain}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
      continue;
    }

    passed.push(article);
  }

  return passed;
}

// ─── Filter 2: Content quality heuristics ───

function filterContentQuality(
  articles: readonly RawArticle[],
  negativeKeywords: readonly string[],
  reasons: Record<string, number>,
): readonly RawArticle[] {
  const passed: RawArticle[] = [];
  const lowerNegatives = negativeKeywords.map((k) => k.toLowerCase());

  for (const article of articles) {
    // Title too short
    if (article.title.length < 15) {
      reasons['title_too_short'] = (reasons['title_too_short'] ?? 0) + 1;
      continue;
    }

    // Title too long
    if (article.title.length > 200) {
      reasons['title_too_long'] = (reasons['title_too_long'] ?? 0) + 1;
      continue;
    }

    // Title all caps (more than 80% uppercase for titles > 20 chars)
    if (article.title.length > 20) {
      const upperCount = [...article.title].filter((c) => c >= 'A' && c <= 'Z').length;
      const letterCount = [...article.title].filter((c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')).length;
      if (letterCount > 0 && upperCount / letterCount > 0.8) {
        reasons['title_all_caps'] = (reasons['title_all_caps'] ?? 0) + 1;
        continue;
      }
    }

    // Snippet too short (unless it's a transcript)
    if (article.snippet.length < 20 && !article.snippet.startsWith('[Transcription]')) {
      reasons['snippet_too_short'] = (reasons['snippet_too_short'] ?? 0) + 1;
      continue;
    }

    // Negative keyword in title
    const lowerTitle = article.title.toLowerCase();
    const matchedNegative = lowerNegatives.find((kw) => lowerTitle.includes(kw));
    if (matchedNegative !== undefined) {
      const key = `negative_keyword:${matchedNegative}`;
      reasons[key] = (reasons[key] ?? 0) + 1;
      continue;
    }

    passed.push(article);
  }

  return passed;
}

// ─── Filter 3: Near-duplicate by title ───

function normalizeTitle(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-zà-ÿ0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

function filterNearDuplicates(
  articles: readonly RawArticle[],
  reasons: Record<string, number>,
): readonly RawArticle[] {
  const passed: RawArticle[] = [];
  const normalized: Array<{ words: Set<string>; article: RawArticle }> = [];

  for (const article of articles) {
    const words = normalizeTitle(article.title);

    // Check against all already-accepted articles
    let isDuplicate = false;
    for (const existing of normalized) {
      if (jaccardSimilarity(words, existing.words) > 0.7) {
        // Keep the one with the longer snippet
        if (article.snippet.length > existing.article.snippet.length) {
          // Replace existing with this one (better snippet)
          const idx = passed.indexOf(existing.article);
          if (idx >= 0) {
            passed[idx] = article;
            existing.article = article;
          }
        }
        isDuplicate = true;
        reasons['near_duplicate'] = (reasons['near_duplicate'] ?? 0) + 1;
        break;
      }
    }

    if (!isDuplicate) {
      passed.push(article);
      normalized.push({ words, article });
    }
  }

  return passed;
}

// ─── Filter 4: Title relevance ───

/**
 * Reject articles whose title doesn't match any category keyword or profile niche term.
 * This prevents sending obviously off-topic articles to the LLM for scoring.
 */
function filterTitleRelevance(
  articles: readonly RawArticle[],
  categories: readonly VeilleCategory[],
  profile: InstanceProfile | undefined,
  reasons: Record<string, number>,
): RawArticle[] {
  // Build keyword set from categories (EN) + profile niche
  const keywords = new Set<string>();
  for (const cat of categories) {
    for (const kw of cat.keywords.en) {
      keywords.add(kw.toLowerCase());
    }
  }
  // Add niche terms (words > 3 chars)
  if (profile !== undefined) {
    for (const term of profile.projectNiche.split(/\s+/)) {
      if (term.length > 3) keywords.add(term.toLowerCase());
    }
  }

  // If no keywords at all, skip this filter
  if (keywords.size === 0) return [...articles];

  return articles.filter((a) => {
    const lower = a.title.toLowerCase();
    for (const kw of keywords) {
      if (lower.includes(kw)) return true;
    }
    // Also check snippet for relevance (some titles are vague)
    const snippetLower = a.snippet.toLowerCase();
    for (const kw of keywords) {
      if (snippetLower.includes(kw)) return true;
    }
    reasons['title_irrelevant'] = (reasons['title_irrelevant'] ?? 0) + 1;
    return false;
  });
}

// ─── Main prefilter function ───

export function prefilter(
  articles: readonly RawArticle[],
  profile: InstanceProfile | undefined,
  db?: SqliteDatabase,
  categories?: readonly VeilleCategory[],
): PrefilterResult {
  const logger = getLogger();
  const reasons: Record<string, number> = {};

  const excludeDomains = profile?.excludeDomains ?? [];
  const negativeKeywords = profile?.negativeKeywords ?? [];

  // Filter 0: DB dedup
  const afterDbDedup = filterDbDedup(articles, db, reasons);

  // Filter 1: URL patterns + excluded domains
  const afterUrlFilter = filterUrlPatterns(afterDbDedup, excludeDomains, reasons);

  // Filter 2: Content quality + negative keywords
  const afterContentFilter = filterContentQuality(afterUrlFilter, negativeKeywords, reasons);

  // Filter 3: Near-duplicate by title
  const afterNearDedup = filterNearDuplicates(afterContentFilter, reasons);

  // Filter 4: Title relevance (skip if no categories)
  const afterTitleRelevance = categories !== undefined && categories.length > 0
    ? filterTitleRelevance(afterNearDedup, categories, profile, reasons)
    : afterNearDedup;

  const stats: PrefilterStats = {
    input: articles.length,
    afterDbDedup: afterDbDedup.length,
    afterUrlFilter: afterUrlFilter.length,
    afterContentFilter: afterContentFilter.length,
    afterNearDedup: afterNearDedup.length,
    afterTitleRelevance: afterTitleRelevance.length,
    rejectedByReason: reasons,
  };

  logger.info({
    input: stats.input,
    afterDbDedup: stats.afterDbDedup,
    afterUrlFilter: stats.afterUrlFilter,
    afterContentFilter: stats.afterContentFilter,
    afterNearDedup: stats.afterNearDedup,
    afterTitleRelevance: stats.afterTitleRelevance,
    rejectedByReason: stats.rejectedByReason,
  }, 'Pre-filter complete');

  return { passed: afterTitleRelevance, stats };
}
