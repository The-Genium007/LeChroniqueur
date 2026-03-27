import { complete } from '../../services/anthropic.js';
import { getLogger } from '../../core/logger.js';
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

const ANALYSIS_SYSTEM_PROMPT = `Tu es un assistant spécialisé dans la création de stratégie de contenu pour les réseaux sociaux.
L'utilisateur te décrit son projet. Tu dois analyser sa description et proposer :
1. Un nom court pour l'instance (2-3 mots max, pas d'espaces ni caractères spéciaux)
2. La niche/domaine principal
3. La langue principale du contenu
4. Les plateformes cibles probables

Réponds en JSON :
{"instanceName": "...", "niche": "...", "language": "fr", "platforms": ["tiktok", "instagram"]}`;

/**
 * Build the initial "describe your project" prompt.
 */
export function buildDescribePrompt(session: WizardSession): V2MessagePayload {
  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🤖 Wizard IA — Étape ${getStepLabel(session.step)}`,
      '',
      '**Décris ton projet en quelques phrases.**',
      '',
      'Par exemple :',
      '> "C\'est Tumulte, un outil de sondages multi-streams pour les MJ de JDR, intégré à Forge VTT. On publie sur TikTok et Instagram en français."',
      '',
      'Plus tu es précis, mieux je pourrai générer tes catégories de veille et ton persona.',
      '',
      `*Tokens utilisés : ${String(session.tokensUsed)} · Itérations : ${String(session.iterationCount)}/20*`,
    ].join('\n')));
  })]);
}

/**
 * Process the user's project description through Claude.
 */
export async function processDescription(
  session: WizardSession,
  description: string,
): Promise<{
  analysis: { instanceName: string; niche: string; language: string; platforms: string[] };
  message: V2MessagePayload;
}> {
  const logger = getLogger();

  addToHistory(session, 'user', description);

  const response = await complete(ANALYSIS_SYSTEM_PROMPT, description, {
    maxTokens: 512,
    temperature: 0.3,
  });

  recordIteration(session, response.tokensIn, response.tokensOut);

  let analysis: { instanceName: string; niche: string; language: string; platforms: string[] };

  try {
    const { extractJson } = await import('../../core/json-extractor.js');
    logger.debug({ rawResponse: response.text.slice(0, 500) }, 'Claude describe response');
    const jsonText = extractJson(response.text);

    analysis = JSON.parse(jsonText) as typeof analysis;
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    logger.warn({ parseError, rawText: response.text.slice(0, 300) }, 'Failed to parse Claude analysis, using defaults');
    analysis = {
      instanceName: 'mon-projet',
      niche: 'contenu digital',
      language: 'fr',
      platforms: ['tiktok', 'instagram'],
    };
  }

  // Store in session — guard against missing fields
  const instanceName = analysis.instanceName ?? 'mon-projet';
  session.data.projectDescription = description;
  session.data.projectName = instanceName;
  session.data.projectNiche = analysis.niche ?? 'contenu digital';
  session.data.projectLanguage = analysis.language ?? 'fr';
  session.data.projectPlatforms = analysis.platforms ?? ['tiktok', 'instagram'];
  session.data.instanceName = instanceName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  addToHistory(session, 'assistant', response.text);

  const message = v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🤖 Wizard IA — Étape ${getStepLabel(session.step)}`,
      '',
      'J\'ai analysé ton projet. Voici ce que je propose :',
      '',
      `🏷️ **Nom** : ${analysis.instanceName}`,
      `🎯 **Niche** : ${analysis.niche}`,
      `🌐 **Langue** : ${analysis.language}`,
      `📱 **Plateformes** : ${analysis.platforms.join(', ')}`,
      '',
      'Tu valides ? Je passe aux catégories de veille.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
      btn('wizard:modify', 'Modifier', ButtonStyle.Primary, '✏️'),
      btn('wizard:redo', 'Régénérer', ButtonStyle.Secondary, '🔄'),
    ));
  })]);

  return { analysis, message };
}
