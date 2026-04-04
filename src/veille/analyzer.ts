import { z } from 'zod';
import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';
import type { RawArticle } from './collector.js';
import type { V2PreferenceEntry as PreferenceEntryData } from '../discord/component-builder-v2.js';
import type { InstanceProfile } from '../core/instance-profile.js';

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

function buildCalibratedExamplesContext(profile?: InstanceProfile): string {
  if (profile?.calibratedExamples === null || profile?.calibratedExamples === undefined || profile.calibratedExamples.length === 0) {
    return '';
  }

  const lines = ['', 'Exemples de scoring calibrés pour cette niche :'];
  for (const ex of profile.calibratedExamples.slice(0, 10)) {
    lines.push(`  - "${ex.title}" → score ${String(ex.expectedScore)} (${ex.reasoning})`);
  }

  return lines.join('\n');
}

function buildAnalysisPrompt(
  articles: readonly RawArticle[],
  preferenceContext: string,
  profile?: InstanceProfile,
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

  const pillars = profile?.pillars ?? ['trend', 'tuto', 'community', 'product'];
  const calibrated = buildCalibratedExamplesContext(profile);

  const contextSection = profile !== undefined && profile.onboardingContext.length > 0
    ? `\nContexte du projet :\n${profile.onboardingContext}\n`
    : '';

  const contentTypesSection = profile !== undefined && profile.contentTypes.length > 0
    ? `\nTypes de contenu recherchés : ${profile.contentTypes.join(', ')}`
    : '';

  const platformsSection = profile !== undefined && profile.targetPlatforms.length > 0
    ? `\nPlateformes cibles : ${profile.targetPlatforms.join(', ')}`
    : '';

  return [
    'Analyse les articles suivants pour la création de contenu sur les réseaux sociaux.',
    contextSection,
    contentTypesSection,
    platformsSection,
    '',
    preferenceContext,
    calibrated,
    '',
    'RÈGLES DE SCORING :',
    '- Le score 5 est INTERDIT. Tu DOIS trancher : 4 (pas assez pertinent) ou 6 (assez pertinent).',
    '- Score 0-2 : hors-sujet, aucun rapport avec la niche',
    '- Score 3-4 : vaguement lié mais pas exploitable pour du contenu',
    '- Score 6-7 : pertinent, exploitable avec un bon angle',
    '- Score 8-10 : très pertinent, fort potentiel viral/engagement',
    '',
    `Les pilliers de contenu sont : ${pillars.join(', ')}`,
    '',
    'Pour chaque article, fournis :',
    '- score (0-10, PAS de 5)',
    `- pillar : un des pilliers ci-dessus (${pillars.join(', ')})`,
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
  ].filter((l) => l.length > 0).join('\n');
}

const DEFAULT_SYSTEM_PROMPT = `Tu es un analyste de veille spécialisé dans la création de contenu pour les réseaux sociaux.
Réponds toujours en JSON valide. Pas de texte avant ou après le JSON.`;

function buildSystemPrompt(persona?: string, profile?: InstanceProfile): string {
  const nicheContext = profile !== undefined && profile.projectNiche.length > 0
    ? `pour le projet "${profile.projectName}" dans la niche "${profile.projectNiche}"`
    : '';

  if (persona !== undefined && persona.length > 0) {
    return [
      persona.slice(0, 1500),
      '',
      `En tant qu'analyste de veille ${nicheContext}, tu évalues la pertinence des articles pour créer du contenu sur les réseaux sociaux dans TA niche.`,
      'Score les articles selon leur potentiel à devenir du contenu engageant pour TON audience.',
      'Un article hors-sujet par rapport à ta niche doit recevoir un score de 0-2.',
      'Un article vaguement lié reçoit 3-4.',
      'Un article très pertinent avec un fort potentiel de contenu reçoit 7-10.',
      'Le score 5 est INTERDIT — tranche entre 4 et 6.',
      '',
      'Réponds toujours en JSON valide. Pas de texte avant ou après le JSON.',
    ].join('\n');
  }

  return DEFAULT_SYSTEM_PROMPT;
}

export async function analyze(
  articles: readonly RawArticle[],
  preferences: readonly PreferenceEntryData[],
  persona?: string,
  profile?: InstanceProfile,
): Promise<AnalysisResult> {
  const logger = getLogger();

  if (articles.length === 0) {
    return { articles: [], tokensUsed: { input: 0, output: 0 } };
  }

  const preferenceContext = buildPreferenceContext(preferences);
  const userMessage = buildAnalysisPrompt(articles, preferenceContext, profile);
  const systemPrompt = buildSystemPrompt(persona, profile);

  logger.debug({ articleCount: articles.length, hasPersona: persona !== undefined, hasProfile: profile !== undefined }, 'Analyzing articles');

  const response = await complete(systemPrompt, userMessage, {
    maxTokens: 8192,
    temperature: 0.3,
    task: 'scoring',
  });

  // Parse the JSON response — validate per-article (not all-or-nothing)
  const pillars = profile?.pillars ?? ['trend', 'tuto', 'community', 'product'];
  const pillarSet = new Set(pillars);
  const defaultPillar = pillars[0] ?? 'trend';

  // Lenient per-article schema: accepts any string for pillar (we validate manually)
  const lenientItemSchema = z.object({
    url: z.string(),
    score: z.number(),
    pillar: z.string(),
    suggestedAngle: z.string(),
    translatedTitle: z.string().optional(),
    translatedSnippet: z.string().optional(),
  });

  const rawArticles: z.infer<typeof lenientItemSchema>[] = [];

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

    const raw = JSON.parse(jsonText) as Record<string, unknown>;
    const articlesArray = Array.isArray(raw['articles']) ? raw['articles'] : [];

    // Validate each article individually — skip invalid ones instead of failing the whole batch
    for (const item of articlesArray) {
      const result = lenientItemSchema.safeParse(item);
      if (result.success) {
        const parsed = result.data;
        // Clamp score to 0-10, skip 5 (round to 4 or 6)
        let score = Math.max(0, Math.min(10, Math.round(parsed.score)));
        if (score === 5) score = 4;
        // Validate pillar — fallback to default if LLM invented one
        const pillar = pillarSet.has(parsed.pillar) ? parsed.pillar : defaultPillar;
        rawArticles.push({ ...parsed, score, pillar });
      } else {
        logger.debug({ error: result.error.message, item: JSON.stringify(item).slice(0, 200) }, 'Skipping invalid article in LLM response');
      }
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), response: response.text.slice(0, 500) },
      'Failed to parse Claude analysis response',
    );
    // Return articles with default scores
    return {
      articles: articles.map((a) => ({
        ...a,
        score: 0,
        pillar: defaultPillar,
        suggestedAngle: '',
      })),
      tokensUsed: { input: response.tokensIn, output: response.tokensOut },
    };
  }

  // Merge analysis results with original articles
  const analyzedMap = new Map(rawArticles.map((a) => [a.url, a]));

  const analyzedArticles: AnalyzedArticle[] = articles.map((article) => {
    const analysis = analyzedMap.get(article.url);

    if (analysis === undefined) {
      return {
        ...article,
        score: 0,
        pillar: defaultPillar,
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
