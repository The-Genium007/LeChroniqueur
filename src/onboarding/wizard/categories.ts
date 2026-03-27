import { complete } from '../../services/anthropic.js';
import { getLogger } from '../../core/logger.js';
import type { InstanceVeilleCategory } from '../../core/config.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import {
  type WizardSession,
  addToHistory,
  recordIteration,
  getStepLabel,
} from './state-machine.js';

const CATEGORIES_SYSTEM_PROMPT = `Tu es un expert en veille et en stratégie de contenu pour les réseaux sociaux.
L'utilisateur te décrit son projet et sa niche. Génère 5 à 8 catégories de veille pertinentes.

Pour chaque catégorie, fournis :
- id : identifiant court en snake_case
- label : nom lisible
- keywords.en : 3-5 mots-clés de recherche en anglais
- keywords.fr : 3-5 mots-clés de recherche en français
- engines : moteurs SearXNG recommandés (parmi : google, google news, reddit, twitter, youtube, hackernews, imgur)
- maxAgeHours : fraîcheur max des articles (48, 72, 168)

Réponds UNIQUEMENT en JSON valide :
{"categories": [{"id": "...", "label": "...", "keywords": {"en": [...], "fr": [...]}, "engines": [...], "maxAgeHours": N}]}`;

/**
 * Generate veille categories based on the project description.
 */
export async function generateCategories(
  session: WizardSession,
): Promise<{
  categories: InstanceVeilleCategory[];
  message: V2MessagePayload;
}> {
  const logger = getLogger();

  const userMessage = [
    `Projet : ${session.data.projectDescription ?? ''}`,
    `Niche : ${session.data.projectNiche ?? ''}`,
    `Langue : ${session.data.projectLanguage ?? 'fr'}`,
    `Plateformes : ${(session.data.projectPlatforms ?? []).join(', ')}`,
  ].join('\n');

  addToHistory(session, 'user', `Génère des catégories de veille pour : ${userMessage}`);

  const response = await complete(CATEGORIES_SYSTEM_PROMPT, userMessage, {
    maxTokens: 2048,
    temperature: 0.7,
  });

  recordIteration(session, response.tokensIn, response.tokensOut);

  let categories: InstanceVeilleCategory[];

  try {
    const { extractJson } = await import('../../core/json-extractor.js');
    const jsonText = extractJson(response.text);

    const parsed = JSON.parse(jsonText) as { categories: Array<{
      id: string;
      label: string;
      keywords: { en: string[]; fr: string[] };
      engines: string[];
      maxAgeHours: number;
    }> };

    categories = parsed.categories.map((cat) => ({
      ...cat,
      isActive: true,
    }));
  } catch {
    logger.warn('Failed to parse categories from Claude, using empty list');
    categories = [];
  }

  session.data.categories = categories;
  addToHistory(session, 'assistant', response.text);

  const catList = categories.map((cat, i) =>
    `**${String(i + 1)}.** ${cat.label} (\`${cat.id}\`)\n   EN: ${cat.keywords.en.slice(0, 3).join(', ')}\n   FR: ${cat.keywords.fr.slice(0, 3).join(', ')}`,
  ).join('\n\n');

  const message = v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🤖 Wizard IA — Étape ${getStepLabel(session.step)}`,
      '',
      `Je propose **${String(categories.length)} catégories de veille** :`,
      '',
      catList,
      '',
      `*Tokens : ${String(session.tokensUsed)} · Itérations : ${String(session.iterationCount)}/20*`,
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider et tester', ButtonStyle.Success, '✅'),
      btn('wizard:modify', 'Modifier', ButtonStyle.Primary, '✏️'),
      btn('wizard:redo', 'Régénérer', ButtonStyle.Secondary, '🔄'),
    ));
  })]);

  return { categories, message };
}
