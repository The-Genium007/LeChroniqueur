import fs from 'node:fs';
import path from 'node:path';
import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';

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

let _personaPrompt: string | undefined;

function loadPersona(): string {
  if (_personaPrompt !== undefined) {
    return _personaPrompt;
  }

  const skillPath = path.join(process.cwd(), 'prompts', 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    return 'Tu es Le Chroniqueur, un MJ légendaire francophone.';
  }

  _personaPrompt = fs.readFileSync(skillPath, 'utf-8');
  return _personaPrompt;
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

    // Basic HTML to text extraction — strip tags, decode entities
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

    // Limit to ~3000 chars to save tokens
    return text.slice(0, 3000);
  } catch (error) {
    logger.warn({ url, error: error instanceof Error ? error.message : String(error) }, 'Article fetch failed');
    return '';
  }
}

export async function deepDive(
  db: SqliteDatabase,
  articleId: number,
): Promise<DeepDiveResult> {
  const logger = getLogger();

  const article = db.prepare('SELECT * FROM veille_articles WHERE id = ?').get(articleId) as VeilleArticleRow | undefined;

  if (article === undefined) {
    throw new Error(`Article ${String(articleId)} not found`);
  }

  // Fetch full content
  const fullContent = await fetchArticleContent(article.url);
  const persona = loadPersona();

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
    '1. Une analyse détaillée (3-5 phrases) : pourquoi c\'est pertinent pour Le Chroniqueur',
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
