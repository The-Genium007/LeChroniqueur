import { getLogger } from '../../core/logger.js';
import { complete } from '../../services/anthropic.js';

/**
 * Site analysis result — extracted from scraping + LLM analysis.
 */
export interface SiteAnalysis {
  readonly productDescription: string;
  readonly targetAudience: string;
  readonly communicationTone: string;
  readonly competitors: string[];
  readonly keywords: string[];
  readonly rawContent: string;
}

/**
 * Scrape a website and analyze it with LLM to understand the project.
 * 1. Fetch HTML + extract with Readability
 * 2. If content is empty/insufficient → fallback to LLM web_search
 * 3. LLM analyzes the content to extract structured insights
 */
export async function scrapeAndAnalyze(url: string): Promise<SiteAnalysis> {
  const logger = getLogger();

  let rawContent = '';

  // Step 1: Try Readability extraction
  try {
    rawContent = await extractWithReadability(url);
    logger.info({ url, contentLength: rawContent.length }, 'Site scraped with Readability');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ url, error: msg }, 'Readability extraction failed');
  }

  // Step 2: Fallback to LLM web_search if content is insufficient
  if (rawContent.length < 100) {
    try {
      rawContent = await searchForSiteInfo(url);
      logger.info({ url, contentLength: rawContent.length }, 'Site info gathered via web search fallback');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ url, error: msg }, 'Web search fallback also failed');
    }
  }

  if (rawContent.length === 0) {
    return {
      productDescription: '',
      targetAudience: '',
      communicationTone: '',
      competitors: [],
      keywords: [],
      rawContent: '',
    };
  }

  // Step 3: LLM analysis
  const analysis = await analyzeSiteContent(url, rawContent);
  return analysis;
}

// ─── Readability extraction ───

async function extractWithReadability(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; LeChroniqueur/1.0; +https://github.com)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }

  const html = await response.text();

  // Use @mozilla/readability + linkedom for DOM parsing
  const { Readability } = await import('@mozilla/readability');
  const { parseHTML } = await import('linkedom');

  const { document } = parseHTML(html);
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();

  if (article === null) {
    // Fallback: extract text from meta tags + headings
    return extractMetaContent(html);
  }

  // Combine title + content, cap at 3000 chars to keep LLM costs low
  const parts = [article.title, article.textContent].filter(Boolean);
  return parts.join('\n\n').slice(0, 3000);
}

function extractMetaContent(html: string): string {
  const parts: string[] = [];

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1] !== undefined) parts.push(titleMatch[1]);

  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (metaDesc?.[1] !== undefined) parts.push(metaDesc[1]);

  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (ogDesc?.[1] !== undefined) parts.push(ogDesc[1]);

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitle?.[1] !== undefined) parts.push(ogTitle[1]);

  return parts.join('\n');
}

// ─── Web search fallback ───

async function searchForSiteInfo(url: string): Promise<string> {
  const { completeWithSearch } = await import('../../services/anthropic.js');

  const response = await completeWithSearch(
    'You are a web researcher. Extract key information about the website/product.',
    `Search for information about this website: ${url}
     Find: what the product/service is, who it's for, what competitors exist, and what tone they use in their communication.
     Return a concise summary in English.`,
    { task: 'scraping' },
  );

  return response.text;
}

// ─── LLM analysis ───

async function analyzeSiteContent(url: string, content: string): Promise<SiteAnalysis> {
  const systemPrompt = `You are a marketing analyst. Analyze the website content and extract structured insights.
Return ONLY valid JSON with these fields:
{
  "productDescription": "What the product/service does, in 2-3 sentences",
  "targetAudience": "Who the target audience is (demographics, interests)",
  "communicationTone": "The tone used (formal, casual, humorous, technical, etc.)",
  "competitors": ["competitor1", "competitor2", ...],
  "keywords": ["keyword1", "keyword2", ...]
}
The keywords should be in English, relevant for content monitoring/veille.
Return 10-15 keywords and 3-5 competitors if identifiable.`;

  const userMessage = `Website URL: ${url}\n\nExtracted content:\n${content.slice(0, 2500)}`;

  const response = await complete(systemPrompt, userMessage, {
    maxTokens: 1024,
    temperature: 0.3,
    task: 'scraping',
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (jsonMatch === null) throw new Error('No JSON found');

    const parsed = JSON.parse(jsonMatch[0]) as {
      productDescription?: string;
      targetAudience?: string;
      communicationTone?: string;
      competitors?: string[];
      keywords?: string[];
    };

    return {
      productDescription: parsed.productDescription ?? '',
      targetAudience: parsed.targetAudience ?? '',
      communicationTone: parsed.communicationTone ?? '',
      competitors: parsed.competitors ?? [],
      keywords: parsed.keywords ?? [],
      rawContent: content,
    };
  } catch {
    return {
      productDescription: response.text.slice(0, 500),
      targetAudience: '',
      communicationTone: '',
      competitors: [],
      keywords: [],
      rawContent: content,
    };
  }
}
