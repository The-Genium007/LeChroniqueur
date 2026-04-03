import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { personaLoader } from '../core/persona-loader.js';

export interface DeepDiveResult {
  readonly analysis: string;
  readonly contentSuggestions: readonly string[];
  readonly tokensUsed: { readonly input: number; readonly output: number };
}

interface VeilleArticleRow {
  id: number;
  url: string;
  title: string;
  translated_title: string | null;
  snippet: string;
  translated_snippet: string | null;
  source: string;
  category: string;
  score: number;
  pillar: string | null;
  suggested_angle: string | null;
}

function loadPersona(instanceId?: string, db?: SqliteDatabase): string {
  if (instanceId !== undefined && db !== undefined) {
    return personaLoader.loadForInstance(instanceId, db);
  }
  return personaLoader.loadLegacy();
}

async function fetchArticleContent(url: string): Promise<string> {
  const logger = getLogger();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 15_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TumulteBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn({ url, status: response.status }, 'Failed to fetch article');
      return '';
    }

    const html = await response.text();

    // Use @mozilla/readability for clean text extraction
    try {
      const dom = new JSDOM(html, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article !== null && article.textContent !== undefined && article.textContent !== null && article.textContent.length > 0) {
        const cleanText = article.textContent.replace(/\s+/g, ' ').trim();
        logger.debug({ url, length: cleanText.length }, 'Article parsed with Readability');
        return cleanText.slice(0, 5000);
      }
    } catch (readabilityError) {
      logger.debug(
        { url, error: readabilityError instanceof Error ? readabilityError.message : String(readabilityError) },
        'Readability parsing failed, falling back to regex strip',
      );
    }

    // Fallback: basic regex strip if Readability fails
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 5000);
  } catch (error) {
    logger.warn({ url, error: error instanceof Error ? error.message : String(error) }, 'Article fetch failed');
    return '';
  }
}

/**
 * Automatically deep-dives the top articles from the current cycle.
 * Only processes articles with score >= 8.
 * Stores the enriched content in veille_articles.deep_dive_content.
 */
export async function autoDeepDive(
  db: SqliteDatabase,
  maxArticles: number = 5,
  instanceId?: string,
): Promise<number> {
  const logger = getLogger();

  // Read threshold from config or use default
  const thresholdRow = db.prepare("SELECT value FROM config_overrides WHERE key = 'minScoreDeepDive'").get() as { value: string } | undefined;
  const minScore = thresholdRow !== undefined ? Number(thresholdRow.value) : 8;

  const articles = db.prepare(`
    SELECT id, score FROM veille_articles
    WHERE score >= ? AND deep_dive_content IS NULL AND status NOT IN ('hors_contexte', 'archived')
    ORDER BY score DESC, collected_at DESC
    LIMIT ?
  `).all(minScore, maxArticles) as Array<{ id: number; score: number }>;

  if (articles.length === 0) {
    logger.info('No articles eligible for auto deep-dive');
    return 0;
  }

  logger.info({ count: articles.length }, 'Starting auto deep-dive');

  let processed = 0;

  for (const article of articles) {
    try {
      const result = await deepDive(db, article.id, instanceId);

      // Store enriched content in DB
      db.prepare(`
        UPDATE veille_articles SET deep_dive_content = ?, status = 'deep_dived' WHERE id = ?
      `).run(
        JSON.stringify({ analysis: result.analysis, suggestions: result.contentSuggestions }),
        article.id,
      );

      processed++;
      logger.debug({ articleId: article.id, score: article.score }, 'Auto deep-dive complete');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ articleId: article.id, error: msg }, 'Auto deep-dive failed for article');
    }
  }

  logger.info({ processed, total: articles.length }, 'Auto deep-dive cycle complete');
  return processed;
}

export async function deepDive(
  db: SqliteDatabase,
  articleId: number,
  instanceId?: string,
): Promise<DeepDiveResult> {
  const logger = getLogger();

  const article = db.prepare('SELECT * FROM veille_articles WHERE id = ?').get(articleId) as VeilleArticleRow | undefined;

  if (article === undefined) {
    throw new Error(`Article ${String(articleId)} not found`);
  }

  // Fetch full content
  const fullContent = await fetchArticleContent(article.url);
  const persona = loadPersona(instanceId, db);

  const title = article.translated_title ?? article.title;
  const snippet = article.translated_snippet ?? article.snippet;

  const userMessage = [
    'Analyse cet article en profondeur et génère des suggestions de contenu.',
    '',
    `TITRE : ${title}`,
    `SOURCE : ${article.source}`,
    `CATÉGORIE : ${article.category}`,
    `ANGLE INITIAL : ${article.suggested_angle ?? 'aucun'}`,
    '',
    'RÉSUMÉ :',
    snippet,
    '',
    fullContent.length > 0 ? `CONTENU COMPLET :\n${fullContent}` : '(contenu complet non disponible)',
    '',
    'GÉNÈRE :',
    '1. Une analyse détaillée (3-5 phrases) : pourquoi c\'est pertinent pour ton audience',
    '2. Exactement 3 suggestions de contenu concrètes, chacune avec :',
    '   - Un hook accrocheur (prêt à publier)',
    '   - Le format recommandé (reel/carrousel/story)',
    '   - Une phrase décrivant le contenu',
    '',
    'Réponds en JSON :',
    '{"analysis": "...", "contentSuggestions": ["Suggestion 1 complète...", "Suggestion 2 complète...", "Suggestion 3 complète..."]}',
  ].join('\n');

  logger.debug({ articleId, hasFullContent: fullContent.length > 0 }, 'Deep diving article');

  const response = await complete(persona, userMessage, {
    maxTokens: 2048,
    temperature: 0.7,
  });

  try {
    let jsonText = response.text.trim();
    if (jsonText.startsWith('```json')) {
      jsonText = jsonText.slice(7);
    }
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.slice(3);
    }
    if (jsonText.endsWith('```')) {
      jsonText = jsonText.slice(0, -3);
    }
    jsonText = jsonText.trim();

    const raw = JSON.parse(jsonText) as Record<string, unknown>;

    return {
      analysis: String(raw['analysis'] ?? ''),
      contentSuggestions: Array.isArray(raw['contentSuggestions'])
        ? (raw['contentSuggestions'] as unknown[]).map(String)
        : [],
      tokensUsed: { input: response.tokensIn, output: response.tokensOut },
    };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to parse deep dive response',
    );

    return {
      analysis: response.text,
      contentSuggestions: [],
      tokensUsed: { input: response.tokensIn, output: response.tokensOut },
    };
  }
}
