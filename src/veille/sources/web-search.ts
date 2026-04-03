import { getLogger } from '../../core/logger.js';
import { completeWithSearch } from '../../services/anthropic.js';
import type { VeilleCategory } from '../queries.js';
import type { RawArticle } from '../collector.js';

/**
 * Uses Claude's native web_search tool for deep, contextual search.
 * More expensive (costs LLM tokens) but finds higher-quality, contextual results.
 * Only runs if explicitly enabled by the user (toggle in onboarding/dashboard).
 */
export async function collectFromWebSearch(
  categories: readonly VeilleCategory[],
  _config: Record<string, unknown>,
): Promise<readonly RawArticle[]> {
  const logger = getLogger();
  const allArticles: RawArticle[] = [];

  // Build a focused search prompt from the top categories
  const categoryDescriptions = categories.slice(0, 5).map((cat) => {
    const kws = [...cat.keywords.fr.slice(0, 2), ...cat.keywords.en.slice(0, 2)].join(', ');
    return `- ${cat.label}: ${kws}`;
  }).join('\n');

  const systemPrompt = [
    'Tu es un agent de veille. Utilise ton outil web_search pour chercher les dernières actualités et tendances.',
    'Pour chaque résultat intéressant trouvé, extrais : URL, titre, résumé court (2-3 phrases), et langue.',
    '',
    'Réponds UNIQUEMENT en JSON :',
    '{"results": [{"url": "...", "title": "...", "snippet": "...", "language": "fr|en"}]}',
  ].join('\n');

  const userMessage = [
    'Cherche les articles et tendances récents (dernière semaine) pour ces catégories :',
    '',
    categoryDescriptions,
    '',
    'Trouve 5-10 résultats pertinents et récents. Privilégie les sources de qualité.',
  ].join('\n');

  try {
    const response = await completeWithSearch(systemPrompt, userMessage, {
      maxTokens: 2048,
      temperature: 0.3,
    });

    let jsonText = response.text.trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7);
    if (jsonText.startsWith('```')) jsonText = jsonText.slice(3);
    if (jsonText.endsWith('```')) jsonText = jsonText.slice(0, -3);
    jsonText = jsonText.trim();

    const parsed = JSON.parse(jsonText) as {
      results: Array<{ url: string; title: string; snippet: string; language: string }>;
    };

    for (const result of parsed.results) {
      allArticles.push({
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        source: 'web_search',
        language: result.language,
        category: 'web_search',
      });
    }

    logger.info({ articles: allArticles.length }, 'LLM web search collection complete');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'LLM web search collection failed');
  }

  return allArticles;
}
