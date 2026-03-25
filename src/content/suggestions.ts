import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { formatProfileForPrompt } from '../feedback/preference-learner.js';

export interface GeneratedSuggestion {
  readonly hook: string;
  readonly script: string;
  readonly pillar: 'trend' | 'tuto' | 'community' | 'product';
  readonly platform: 'tiktok' | 'instagram' | 'both';
  readonly format: 'reel' | 'carousel' | 'story' | 'post';
  readonly hashtags: readonly string[];
  readonly suggestedTime: string;
  readonly sourceArticleId?: number | undefined;
}

const suggestionItemSchema = z.object({
  hook: z.string().min(1),
  script: z.string().min(1),
  pillar: z.enum(['trend', 'tuto', 'community', 'product']),
  platform: z.enum(['tiktok', 'instagram', 'both']),
  format: z.enum(['reel', 'carousel', 'story', 'post']),
  hashtags: z.array(z.string()),
  suggestedTime: z.string(),
  sourceArticleId: z.number().optional(),
});

const suggestionsResponseSchema = z.object({
  suggestions: z.array(suggestionItemSchema),
});

let _personaPrompt: string | undefined;

function loadPersona(): string {
  if (_personaPrompt !== undefined) {
    return _personaPrompt;
  }

  const skillPath = path.join(process.cwd(), 'prompts', 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    return 'Tu es Le Chroniqueur, un MJ légendaire francophone. Tutoiement, sarcasme taquin, références JDR.';
  }

  _personaPrompt = fs.readFileSync(skillPath, 'utf-8');
  return _personaPrompt;
}

interface RecentArticle {
  id: number;
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

function getRecentTopArticles(db: SqliteDatabase, limit: number = 10): readonly RecentArticle[] {
  return db.prepare(`
    SELECT id, title, translated_title, snippet, translated_snippet,
           source, category, score, pillar, suggested_angle
    FROM veille_articles
    WHERE score >= 6
      AND status IN ('new', 'proposed')
      AND collected_at >= datetime('now', '-3 days')
    ORDER BY score DESC
    LIMIT ?
  `).all(limit) as RecentArticle[];
}

function buildSuggestionsPrompt(
  articles: readonly RecentArticle[],
  preferenceProfile: string,
  count: number,
): string {
  const articleList = articles.map((a) => {
    const title = a.translated_title ?? a.title;
    const snippet = a.translated_snippet ?? a.snippet;
    const angle = a.suggested_angle ?? '';
    return `[ID:${String(a.id)}] ${title} (${a.source}, score ${String(a.score)}/10, ${a.category})\n  ${snippet}\n  Angle suggéré: ${angle}`;
  }).join('\n\n');

  return [
    `Génère exactement ${String(count)} suggestions de contenu pour les réseaux sociaux.`,
    '',
    'CONTEXTE :',
    '- Tu publies sur TikTok et Instagram en tant que Le Chroniqueur',
    '- Ton audience : MJ et joueurs JDR francophones',
    '- Le contenu doit respecter la "règle du pont" : chaque post DOIT contenir un lien vers le TTRPG ou Tumulte',
    '',
    preferenceProfile,
    '',
    'ARTICLES DE VEILLE RÉCENTS (utilise-les comme inspiration) :',
    articleList.length > 0 ? articleList : '(aucun article récent — génère des suggestions basées sur tes connaissances JDR)',
    '',
    'POUR CHAQUE SUGGESTION, FOURNIS :',
    '- hook : la phrase d\'accroche exacte (prête à publier, en français)',
    '- script : le déroulé complet (seconde par seconde pour vidéo, slide par slide pour carrousel)',
    '- pillar : "trend", "tuto", "community", ou "product"',
    '- platform : "tiktok", "instagram", ou "both"',
    '- format : "reel", "carousel", "story", ou "post"',
    '- hashtags : liste de hashtags pertinents',
    '- suggestedTime : heure de publication optimale (ex: "mardi 19h")',
    '- sourceArticleId : l\'ID de l\'article source si applicable (sinon omettre)',
    '',
    'RÈGLES :',
    '- Le hook est TOUJOURS une anecdote ou une question, JAMAIS un pitch',
    '- La fin est TOUJOURS une punchline, une question au lecteur, ou un cliffhanger',
    '- Tumulte est VISIBLE (captures d\'écran mentionnées) mais JAMAIS nommé en mode promo',
    '- Tutoiement TOUJOURS',
    '- N\'utilise JAMAIS ces mots : "solution", "innovant", "révolutionnaire", "découvrez", "n\'hésitez pas", "notre produit"',
    '- Emojis autorisés : 🎲 ⚔️ 🐉 🔥 💀 📜 ✨',
    '',
    'Réponds UNIQUEMENT avec un JSON valide :',
    '{"suggestions": [{"hook": "...", "script": "...", "pillar": "...", "platform": "...", "format": "...", "hashtags": [...], "suggestedTime": "...", "sourceArticleId": N}]}',
  ].join('\n');
}

export async function generateSuggestions(
  db: SqliteDatabase,
  count: number = 3,
): Promise<readonly GeneratedSuggestion[]> {
  const logger = getLogger();

  const persona = loadPersona();
  const preferenceProfile = formatProfileForPrompt(db);
  const articles = getRecentTopArticles(db);

  const userMessage = buildSuggestionsPrompt(articles, preferenceProfile, count);

  logger.debug({ articleCount: articles.length, count }, 'Generating suggestions');

  const response = await complete(persona, userMessage, {
    maxTokens: 4096,
    temperature: 0.8,
  });

  let parsed: z.infer<typeof suggestionsResponseSchema>;

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

    const raw: unknown = JSON.parse(jsonText);
    parsed = suggestionsResponseSchema.parse(raw);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      'Failed to parse suggestions response',
    );
    return [];
  }

  logger.info(
    { generated: parsed.suggestions.length, tokensIn: response.tokensIn, tokensOut: response.tokensOut },
    'Suggestions generated',
  );

  return parsed.suggestions;
}

export async function modifySuggestion(
  _db: SqliteDatabase,
  originalContent: string,
  modificationInstructions: string,
): Promise<string> {
  const logger = getLogger();
  const persona = loadPersona();

  const userMessage = [
    'Modifie le contenu suivant selon les instructions.',
    '',
    'CONTENU ORIGINAL :',
    originalContent,
    '',
    'INSTRUCTIONS DE MODIFICATION :',
    modificationInstructions,
    '',
    'Retourne uniquement le contenu modifié, pas de JSON, pas d\'explication. Garde le même format et le même ton.',
  ].join('\n');

  const response = await complete(persona, userMessage, {
    maxTokens: 2048,
    temperature: 0.7,
  });

  logger.debug({ tokensIn: response.tokensIn, tokensOut: response.tokensOut }, 'Suggestion modified');

  return response.text;
}
