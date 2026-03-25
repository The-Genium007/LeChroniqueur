import { z } from 'zod';
import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';
import type { RawArticle } from './collector.js';
import type { PreferenceEntryData } from '../discord/message-builder.js';

export interface AnalyzedArticle extends RawArticle {
  readonly score: number;
  readonly pillar: string;
  readonly suggestedAngle: string;
  readonly translatedTitle?: string | undefined;
  readonly translatedSnippet?: string | undefined;
}

export interface AnalysisResult {
  readonly articles: readonly AnalyzedArticle[];
  readonly tokensUsed: { readonly input: number; readonly output: number };
}

const analysisItemSchema = z.object({
  url: z.string(),
  score: z.number().int().min(0).max(10),
  pillar: z.enum(['trend', 'tuto', 'community', 'product']),
  suggestedAngle: z.string(),
  translatedTitle: z.string().optional(),
  translatedSnippet: z.string().optional(),
});

const analysisResponseSchema = z.object({
  articles: z.array(analysisItemSchema),
});

function buildPreferenceContext(preferences: readonly PreferenceEntryData[]): string {
  if (preferences.length === 0) {
    return 'Aucun profil de préférences disponible. Score les articles selon ta propre évaluation.';
  }

  const lines: string[] = [`Profil de préférences (basé sur les retours utilisateur) :`];

  const dimensions = ['source', 'category', 'pillar', 'keyword'] as const;
  const labels: Record<string, string> = {
    source: 'Sources',
    category: 'Catégories',
    pillar: 'Piliers',
    keyword: 'Mots-clés',
  };

  for (const dim of dimensions) {
    const entries = preferences
      .filter((e) => e.dimension === dim)
      .sort((a, b) => b.score - a.score);

    if (entries.length === 0) continue;

    lines.push(`\n${labels[dim]} :`);
    for (const e of entries) {
      const sign = e.score >= 0 ? '+' : '';
      lines.push(`  ${e.value}: ${sign}${e.score.toFixed(2)} (${String(e.totalCount)} ratings)`);
    }
  }

  lines.push('\nUtilise ce profil pour pondérer ton scoring. +2 bonus pour FORTE PRÉFÉRENCE, -2 malus pour "à éviter".');

  return lines.join('\n');
}

function buildAnalysisPrompt(
  articles: readonly RawArticle[],
  preferenceContext: string,
): string {
  const articleList = articles.map((a, i) => {
    return [
      `[${String(i)}] URL: ${a.url}`,
      `    Titre: ${a.title}`,
      `    Snippet: ${a.snippet}`,
      `    Source: ${a.source}`,
      `    Langue: ${a.language}`,
      `    Catégorie: ${a.category}`,
    ].join('\n');
  }).join('\n\n');

  return [
    'Analyse les articles suivants pour un créateur de contenu TTRPG/JDR francophone.',
    '',
    preferenceContext,
    '',
    'Pour chaque article, fournis :',
    '- score (0-10) : pertinence pour créer du contenu JDR/Tumulte',
    '- pillar : "trend", "tuto", "community", ou "product"',
    '- suggestedAngle : un angle de contenu accrocheur en français (1-2 phrases)',
    '- translatedTitle : traduction FR du titre si l\'article est en anglais',
    '- translatedSnippet : traduction FR du snippet si l\'article est en anglais',
    '',
    'Réponds UNIQUEMENT avec un JSON valide au format :',
    '{"articles": [{"url": "...", "score": N, "pillar": "...", "suggestedAngle": "...", "translatedTitle": "...", "translatedSnippet": "..."}]}',
    '',
    'Articles à analyser :',
    '',
    articleList,
  ].join('\n');
}

const SYSTEM_PROMPT = `Tu es un analyste de veille spécialisé dans le JDR/TTRPG et la création de contenu pour les réseaux sociaux.
Tu analyses des articles pour un créateur francophone qui publie sur TikTok et Instagram sous le persona d'un MJ légendaire.
Réponds toujours en JSON valide. Pas de texte avant ou après le JSON.`;

export async function analyze(
  articles: readonly RawArticle[],
  preferences: readonly PreferenceEntryData[],
): Promise<AnalysisResult> {
  const logger = getLogger();

  if (articles.length === 0) {
    return { articles: [], tokensUsed: { input: 0, output: 0 } };
  }

  const preferenceContext = buildPreferenceContext(preferences);
  const userMessage = buildAnalysisPrompt(articles, preferenceContext);

  logger.debug({ articleCount: articles.length }, 'Analyzing articles with Claude');

  const response = await complete(SYSTEM_PROMPT, userMessage, {
    maxTokens: 4096,
    temperature: 0.3,
  });

  // Parse and validate the JSON response
  let parsed: z.infer<typeof analysisResponseSchema>;

  try {
    // Extract JSON from response (Claude might add backticks)
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

    const raw: unknown = JSON.parse(jsonText);
    parsed = analysisResponseSchema.parse(raw);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), response: response.text.slice(0, 500) },
      'Failed to parse Claude analysis response',
    );
    // Return articles with default scores
    return {
      articles: articles.map((a) => ({
        ...a,
        score: 5,
        pillar: 'trend' as const,
        suggestedAngle: '',
      })),
      tokensUsed: { input: response.tokensIn, output: response.tokensOut },
    };
  }

  // Merge analysis results with original articles
  const analyzedMap = new Map(parsed.articles.map((a) => [a.url, a]));

  const analyzedArticles: AnalyzedArticle[] = articles.map((article) => {
    const analysis = analyzedMap.get(article.url);

    if (analysis === undefined) {
      return {
        ...article,
        score: 5,
        pillar: 'trend' as const,
        suggestedAngle: '',
      };
    }

    return {
      ...article,
      score: analysis.score,
      pillar: analysis.pillar,
      suggestedAngle: analysis.suggestedAngle,
      translatedTitle: analysis.translatedTitle,
      translatedSnippet: analysis.translatedSnippet,
    };
  });

  return {
    articles: analyzedArticles,
    tokensUsed: { input: response.tokensIn, output: response.tokensOut },
  };
}
