import { complete } from '../services/anthropic.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { type InstanceProfile, type CalibratedExample, saveCalibratedExamples } from '../core/instance-profile.js';

const SYSTEM_PROMPT = `Tu es un expert en veille et curation de contenu. Tu génères des exemples d'articles fictifs mais réalistes pour calibrer un système de scoring automatique.

Chaque exemple doit avoir :
- title : un titre d'article réaliste (en français ou anglais)
- expectedScore : le score que tu donnerais (0-10, PAS de 5)
- reasoning : pourquoi ce score (1 phrase courte)

Le score 5 est INTERDIT. Répartis les scores : 2 articles à 0-2, 2 à 3-4, 3 à 6-7, 3 à 8-10.

Réponds UNIQUEMENT en JSON valide : { "examples": [...] }`;

/**
 * Generate calibrated scoring examples for an instance's niche.
 * Called in background after onboarding, not blocking.
 */
export async function generateCalibratedExamples(
  db: SqliteDatabase,
  profile: InstanceProfile,
  persona: string,
): Promise<readonly CalibratedExample[]> {
  const logger = getLogger();

  logger.info({ projectName: profile.projectName, niche: profile.projectNiche }, 'Generating calibrated examples');

  const userMessage = [
    `Projet : "${profile.projectName}"`,
    `Niche : ${profile.projectNiche}`,
    profile.onboardingContext.length > 0 ? `Contexte : ${profile.onboardingContext.slice(0, 500)}` : '',
    profile.contentTypes.length > 0 ? `Types de contenu : ${profile.contentTypes.join(', ')}` : '',
    profile.targetPlatforms.length > 0 ? `Plateformes : ${profile.targetPlatforms.join(', ')}` : '',
    '',
    'Génère 10 exemples d\'articles fictifs mais réalistes qui correspondent à cette niche.',
    'Inclus des exemples clairement hors-sujet (score 0-2), vaguement liés (score 3-4), pertinents (score 6-7), et très pertinents (score 8-10).',
  ].filter((l) => l.length > 0).join('\n');

  const response = await complete(
    persona.length > 0 ? `${persona.slice(0, 500)}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT,
    userMessage,
    { maxTokens: 2048, temperature: 0.7 },
  );

  try {
    let jsonText = response.text.trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7);
    if (jsonText.startsWith('```')) jsonText = jsonText.slice(3);
    if (jsonText.endsWith('```')) jsonText = jsonText.slice(0, -3);
    jsonText = jsonText.trim();

    const parsed = JSON.parse(jsonText) as { examples: CalibratedExample[] };
    const examples = parsed.examples ?? [];

    // Save to DB
    saveCalibratedExamples(db, examples);

    logger.info({ count: examples.length }, 'Calibrated examples generated and saved');
    return examples;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg, response: response.text.slice(0, 300) }, 'Failed to parse calibrated examples');
    return [];
  }
}
