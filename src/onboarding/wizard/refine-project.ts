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

const REFINE_QUESTIONS = [
  '1️⃣ Quels sont tes **concurrents ou références** dans ta niche ?\n   (comptes, sites, créateurs que tu suis ou admires)',
  '2️⃣ Quels **sujets ou mots-clés** tu veux absolument surveiller ?\n   (termes précis que tu ne veux pas rater)',
  '3️⃣ Quels **sujets tu veux exclure** de ta veille ?\n   (bruit récurrent, hors-sujet, spam)',
  '4️⃣ Quels **sites ou blogs** font référence dans ta niche ?\n   (sources fiables que tu consultes toi-même)',
  '5️⃣ Quel est le **but principal** de ta communication ?\n   (vendre un produit, construire une audience, éduquer, divertir...)',
  '6️⃣ **Autre chose à savoir** sur ton projet, ton produit, ta cible ?\n   (optionnel — texte libre pour ajouter du contexte)',
] as const;

const EXTRACT_SYSTEM_PROMPT = `Tu es un assistant qui extrait des données structurées à partir de réponses textuelles d'un utilisateur.

Contexte du projet :
- Nom : {projectName}
- Niche : {projectNiche}
- Plateformes : {platforms}

L'utilisateur a répondu à 6 questions pour affiner sa veille. Extrais les données suivantes :

1. include_domains : domaines web de référence mentionnés (ex: "screenrant.com", "polygon.com"). Déduis aussi des domaines depuis les noms de sites ou blogs mentionnés.
2. exclude_domains : domaines à exclure mentionnés ou sous-entendus
3. negative_keywords : mots-clés ou sujets à exclure. Inclus les termes en anglais ET français.
4. additional_keywords : mots-clés à surveiller en priorité
5. context : un résumé structuré de toutes les réponses (3-5 phrases) qui servira de contexte pour le scoring des articles

Réponds en JSON :
{"include_domains": [...], "exclude_domains": [...], "negative_keywords": [...], "additional_keywords": [...], "context": "..."}`;

/**
 * Build the refine questions display.
 */
export function buildRefineQuestions(session: WizardSession): V2MessagePayload {
  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 📋 Quelques questions — Étape ${getStepLabel(session.step)}`,
      '',
      'Réponds à chaque question ci-dessous. Tu peux répondre à tout d\'un coup',
      'ou question par question. **Numérote tes réponses** (1. ... 2. ... etc.)',
      '',
      ...REFINE_QUESTIONS,
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Passer cette étape', ButtonStyle.Secondary, '⏭️'),
      btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}

interface ExtractedData {
  includeDomains: string[];
  excludeDomains: string[];
  negativeKeywords: string[];
  additionalKeywords: string[];
  context: string;
}

/**
 * Process user answers to the refine questions via LLM extraction.
 */
export async function processRefineAnswers(
  session: WizardSession,
  answers: string,
): Promise<{
  extracted: ExtractedData;
  message: V2MessagePayload;
}> {
  const logger = getLogger();

  addToHistory(session, 'user', answers);

  const systemPrompt = EXTRACT_SYSTEM_PROMPT
    .replace('{projectName}', session.data.projectName ?? '')
    .replace('{projectNiche}', session.data.projectNiche ?? '')
    .replace('{platforms}', (session.data.projectPlatforms ?? []).join(', '));

  const userMessage = [
    'Réponses de l\'utilisateur aux 6 questions :',
    '',
    answers,
  ].join('\n');

  const response = await complete(systemPrompt, userMessage, {
    maxTokens: 1024,
    temperature: 0.3,
  });

  recordIteration(session, response.tokensIn, response.tokensOut);

  let extracted: ExtractedData;

  try {
    const { extractJson } = await import('../../core/json-extractor.js');
    logger.debug({ rawResponse: response.text.slice(0, 500) }, 'Claude refine response');
    const jsonText = extractJson(response.text);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;

    extracted = {
      includeDomains: Array.isArray(parsed['include_domains']) ? (parsed['include_domains'] as string[]) : [],
      excludeDomains: Array.isArray(parsed['exclude_domains']) ? (parsed['exclude_domains'] as string[]) : [],
      negativeKeywords: Array.isArray(parsed['negative_keywords']) ? (parsed['negative_keywords'] as string[]) : [],
      additionalKeywords: Array.isArray(parsed['additional_keywords']) ? (parsed['additional_keywords'] as string[]) : [],
      context: typeof parsed['context'] === 'string' ? parsed['context'] : '',
    };
  } catch (error) {
    const parseError = error instanceof Error ? error.message : String(error);
    logger.warn({ parseError, rawText: response.text.slice(0, 300) }, 'Failed to parse refine response, storing raw answers');
    extracted = {
      includeDomains: [],
      excludeDomains: [],
      negativeKeywords: [],
      additionalKeywords: [],
      context: answers.slice(0, 2000),
    };
  }

  // Store in session
  session.data.includeDomains = extracted.includeDomains;
  session.data.excludeDomains = extracted.excludeDomains;
  session.data.negativeKeywords = extracted.negativeKeywords;
  session.data.onboardingContext = extracted.context;

  addToHistory(session, 'assistant', response.text);

  const message = buildProfileValidation(session, extracted);

  return { extracted, message };
}

/**
 * Build the profile validation display (shows what was extracted).
 */
export function buildProfileValidation(session: WizardSession, extracted?: ExtractedData): V2MessagePayload {
  const domains = extracted?.includeDomains ?? session.data.includeDomains ?? [];
  const excluded = extracted?.excludeDomains ?? session.data.excludeDomains ?? [];
  const negatives = extracted?.negativeKeywords ?? session.data.negativeKeywords ?? [];
  const context = extracted?.context ?? session.data.onboardingContext ?? '';

  const lines = [
    `## 🔍 Profil de recherche — Étape ${getStepLabel(session.step)}`,
    '',
    `📌 **Projet** : ${session.data.projectName ?? ''}`,
    `🎯 **Niche** : ${session.data.projectNiche ?? ''}`,
  ];

  if (session.data.projectUrl !== undefined) {
    lines.push(`🌐 **Site** : ${session.data.projectUrl}`);
  }

  lines.push(
    `📱 **Plateformes** : ${(session.data.projectPlatforms ?? []).join(', ')}`,
    `📝 **Contenu** : ${(session.data.contentTypes ?? []).join(', ')}`,
  );

  if (domains.length > 0) {
    lines.push('', `✅ **Domaines de référence** : ${domains.join(', ')}`);
  }
  if (excluded.length > 0) {
    lines.push(`❌ **Domaines exclus** : ${excluded.join(', ')}`);
  }
  if (negatives.length > 0) {
    lines.push(`🚫 **Mots-clés exclus** : ${negatives.map((k) => `"${k}"`).join(', ')}`);
  }
  if (context.length > 0) {
    lines.push('', `📄 **Contexte** : ${context.slice(0, 300)}${context.length > 300 ? '...' : ''}`);
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt(lines.join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
      btn('wizard:modify', 'Modifier', ButtonStyle.Primary, '✏️'),
      btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}
