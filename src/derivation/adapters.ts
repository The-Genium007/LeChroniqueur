import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { complete, type AnthropicResponse } from '../services/anthropic.js';
import { recordAnthropicUsage } from '../budget/tracker.js';

// ─── Platform text constraints ───

interface PlatformTextConstraints {
  readonly maxLength: number | null;
  readonly tone: string;
  readonly structure: string;
  readonly hashtagStyle: string;
}

const PLATFORM_CONSTRAINTS: Readonly<Record<string, PlatformTextConstraints>> = {
  tiktok: {
    maxLength: 2200,
    tone: 'Décontracté, percutant, jeune. Tutoiement.',
    structure: 'Hook accrocheur + contenu concis + CTA. Hashtags à la fin.',
    hashtagStyle: 'Populaires + niche, 5-8 hashtags max.',
  },
  instagram: {
    maxLength: 2200,
    tone: 'Engageant, visuel, communautaire. Tutoiement.',
    structure: 'Hook → développement → CTA. Hashtags séparés par un saut de ligne.',
    hashtagStyle: 'Mix populaires + spécialisés, 10-15 hashtags.',
  },
  x: {
    maxLength: 280,
    tone: 'Concis, percutant, provocateur si pertinent. Tutoiement.',
    structure: 'Message direct, pas de fluff. 1-2 hashtags max intégrés au texte.',
    hashtagStyle: 'Intégrés au texte, 1-2 max.',
  },
  linkedin: {
    maxLength: 1300,
    tone: 'Professionnel mais accessible, thought leadership. Vouvoiement possible.',
    structure: 'Insight percutant → contexte → développement → takeaway actionable.',
    hashtagStyle: 'Professionnels, 3-5 hashtags en fin de post.',
  },
  facebook: {
    maxLength: 5000,
    tone: 'Conversationnel, accessible, communautaire. Tutoiement.',
    structure: 'Question ou accroche → contenu → invitation à commenter.',
    hashtagStyle: '2-3 hashtags max, pas obligatoire.',
  },
  youtube: {
    maxLength: 500,
    tone: 'Dynamique, descriptif. Tutoiement.',
    structure: 'Titre accrocheur (≤100 chars) + description avec contexte. Hashtags dans la description.',
    hashtagStyle: '3-5 hashtags pertinents.',
  },
  threads: {
    maxLength: 500,
    tone: 'Décontracté, authentique, conversationnel. Tutoiement.',
    structure: 'Message direct et engageant, comme un message à un ami.',
    hashtagStyle: '1-3 hashtags intégrés.',
  },
  bluesky: {
    maxLength: 300,
    tone: 'Décontracté, tech-savvy, authentique. Tutoiement.',
    structure: 'Message concis et direct.',
    hashtagStyle: '1-2 hashtags intégrés.',
  },
  reddit: {
    maxLength: 10000,
    tone: 'Communautaire, authentique, pas de jargon marketing. Tutoiement.',
    structure: 'Titre accrocheur. Corps : contexte court → développement → question ouverte pour discussion. Pas de promotion directe.',
    hashtagStyle: 'Pas de hashtags sur Reddit.',
  },
  mastodon: {
    maxLength: 500,
    tone: 'Respectueux, communautaire, tech-friendly. Tutoiement.',
    structure: 'Message clair avec contexte. Hashtags pour la découvrabilité.',
    hashtagStyle: '3-5 hashtags, importants pour la découverte sur le fediverse.',
  },
  pinterest: {
    maxLength: 500,
    tone: 'Descriptif, SEO-friendly, inspirant.',
    structure: 'Description riche en mots-clés. Pas de CTA agressif.',
    hashtagStyle: '5-10 hashtags SEO ciblés.',
  },
};

// ─── Article-specific instructions ───

const ARTICLE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  reddit: 'Structure: titre accrocheur → contexte court → développement détaillé → question ouverte. Ton: communautaire, authentique, pas de jargon marketing. Inviter la discussion. Le post doit apporter de la valeur et ne pas ressembler à de la promotion.',
  linkedin: 'Structure: insight percutant → analyse approfondie → exemples concrets → takeaway actionable. Ton: professionnel, thought leadership. Vocabulaire industrie/gaming/tech.',
};

// ─── Thread X (Twitter) generation ───

export interface GeneratedTweet {
  readonly index: number;
  readonly text: string;
  readonly hasImage: boolean;
}

export interface ThreadResult {
  readonly tweets: readonly GeneratedTweet[];
}

// ─── Carousel generation ───

export interface CarouselSlide {
  readonly index: number;
  readonly imagePrompt: string;
  readonly overlayText: string;
}

export interface CarouselResult {
  readonly slideCount: number;
  readonly slides: readonly CarouselSlide[];
  readonly caption: string;
}

// ─── Main adaptation function ───

export async function adaptTextForPlatform(
  db: SqliteDatabase,
  masterText: string,
  platform: string,
  format: string,
  persona: string,
): Promise<{ text: string; response: AnthropicResponse }> {
  const logger = getLogger();
  const constraints = PLATFORM_CONSTRAINTS[platform];

  if (constraints === undefined) {
    throw new Error(`Unknown platform: ${platform}`);
  }

  const systemPrompt = [
    persona,
    '',
    '## Tâche',
    `Tu dois adapter le contenu suivant pour ${platform} au format ${format}.`,
    '',
    '## Contraintes de la plateforme',
    `- Longueur max : ${constraints.maxLength !== null ? `${String(constraints.maxLength)} caractères` : 'pas de limite'}`,
    `- Ton : ${constraints.tone}`,
    `- Structure : ${constraints.structure}`,
    `- Hashtags : ${constraints.hashtagStyle}`,
    '',
    '## Règles',
    '- Adapte le contenu, ne le traduis pas mot à mot',
    '- Garde l\'essence du message mais reformule pour la plateforme',
    '- Respecte STRICTEMENT la limite de caractères',
    '- Le contenu doit être autonome (compréhensible sans contexte)',
    '- Respecte les mots interdits définis dans le persona',
    '',
    '## Format de sortie',
    'Retourne UNIQUEMENT le texte adapté, sans markdown, sans explication.',
  ].join('\n');

  logger.debug({ platform, format }, 'Adapting text for platform');

  const response = await complete(systemPrompt, masterText, {
    maxTokens: 2048,
    temperature: 0.7,
  });

  recordAnthropicUsage(db, response.tokensIn, response.tokensOut);

  return { text: response.text.trim(), response };
}

// ─── Thread generation ───

export async function generateThread(
  db: SqliteDatabase,
  masterText: string,
  persona: string,
): Promise<{ thread: ThreadResult; response: AnthropicResponse }> {
  const logger = getLogger();

  const systemPrompt = [
    persona,
    '',
    '## Tâche',
    'Tu dois créer un thread X (Twitter) à partir du contenu suivant.',
    'Chaque tweet doit faire 280 caractères maximum.',
    'L\'image sera attachée au premier tweet uniquement.',
    '',
    '## Règles',
    '- 3 à 8 tweets par thread',
    '- Chaque tweet est autonome mais s\'inscrit dans le fil',
    '- Le premier tweet est l\'accroche (hook)',
    '- Le dernier tweet est un CTA ou une question ouverte',
    '- Numérote les tweets (1/, 2/, etc.) au début',
    '- Tutoiement obligatoire',
    '',
    '## Format de sortie (JSON strict)',
    '```json',
    '{ "tweets": [{ "index": 1, "text": "...", "hasImage": true }, ...] }',
    '```',
    'Retourne UNIQUEMENT le JSON, sans markdown fences.',
  ].join('\n');

  logger.debug('Generating X thread');

  const response = await complete(systemPrompt, masterText, {
    maxTokens: 2048,
    temperature: 0.8,
  });

  recordAnthropicUsage(db, response.tokensIn, response.tokensOut);

  const cleaned = response.text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as ThreadResult;

  return { thread: parsed, response };
}

// ─── Carousel generation ───

export async function generateCarouselPlan(
  db: SqliteDatabase,
  masterText: string,
  masterImagePrompt: string,
  persona: string,
): Promise<{ carousel: CarouselResult; response: AnthropicResponse }> {
  const logger = getLogger();

  const systemPrompt = [
    persona,
    '',
    '## Tâche',
    'Tu dois créer un plan de carousel Instagram à partir du contenu suivant.',
    'Le nombre de slides est variable (3 à 10) selon la richesse du contenu.',
    '',
    '## Contexte visuel',
    `Le prompt image master est : "${masterImagePrompt}"`,
    'Chaque slide doit avoir un prompt image cohérent avec ce style.',
    '',
    '## Règles',
    '- Slide 1 : accroche visuelle forte',
    '- Slides intermédiaires : contenu informatif, 1 idée par slide',
    '- Dernière slide : CTA ou conclusion',
    '- Chaque overlayText fait max 50 caractères (texte sur l\'image)',
    '- Les prompts image maintiennent la cohérence visuelle (palette, style, personnages)',
    '- Inclus aussi une caption Instagram pour le carousel',
    '',
    '## Format de sortie (JSON strict)',
    '```json',
    '{',
    '  "slideCount": 5,',
    '  "slides": [',
    '    { "index": 1, "imagePrompt": "...", "overlayText": "..." }',
    '  ],',
    '  "caption": "..."',
    '}',
    '```',
    'Retourne UNIQUEMENT le JSON, sans markdown fences.',
  ].join('\n');

  logger.debug('Generating carousel plan');

  const response = await complete(systemPrompt, masterText, {
    maxTokens: 4096,
    temperature: 0.8,
  });

  recordAnthropicUsage(db, response.tokensIn, response.tokensOut);

  const cleaned = response.text.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned) as CarouselResult;

  return { carousel: parsed, response };
}

// ─── Article generation ───

export async function generateArticle(
  db: SqliteDatabase,
  masterText: string,
  platform: string,
  persona: string,
): Promise<{ text: string; response: AnthropicResponse }> {
  const logger = getLogger();
  const instructions = ARTICLE_INSTRUCTIONS[platform];

  if (instructions === undefined) {
    throw new Error(`No article instructions for platform: ${platform}`);
  }

  const systemPrompt = [
    persona,
    '',
    '## Tâche',
    `Tu dois écrire un article pour ${platform} à partir du contenu suivant.`,
    '',
    '## Instructions spécifiques',
    instructions,
    '',
    '## Règles',
    '- Le contenu doit être développé, pas juste reformulé',
    '- Apporte de la valeur ajoutée (contexte, exemples, analyse)',
    '- Le ton doit être naturel et authentique pour la plateforme',
    '- Respecte les mots interdits définis dans le persona',
    '',
    '## Format de sortie',
    'Retourne UNIQUEMENT le texte de l\'article, sans markdown de premier niveau.',
    platform === 'reddit' ? 'Première ligne = titre du post. Reste = corps.' : '',
  ].join('\n');

  logger.debug({ platform }, 'Generating article');

  const response = await complete(systemPrompt, masterText, {
    maxTokens: 4096,
    temperature: 0.7,
  });

  recordAnthropicUsage(db, response.tokensIn, response.tokensOut);

  return { text: response.text.trim(), response };
}

/**
 * Returns the platform constraints for UI display purposes.
 */
export function getPlatformConstraints(platform: string): PlatformTextConstraints | undefined {
  return PLATFORM_CONSTRAINTS[platform];
}
