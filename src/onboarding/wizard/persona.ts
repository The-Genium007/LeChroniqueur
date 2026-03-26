import { complete } from '../../services/anthropic.js';
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

type PersonaSection = 'identity' | 'tone' | 'vocabulary' | 'art_direction' | 'examples';

const SECTION_LABELS: Record<PersonaSection, string> = {
  identity: '🎭 Identité',
  tone: '🗣️ Ton & personnalité',
  vocabulary: '📝 Vocabulaire',
  art_direction: '🎨 Direction artistique',
  examples: '✍️ Exemples de voix',
};

const SECTION_PROMPTS: Record<PersonaSection, string> = {
  identity: `Génère la section IDENTITÉ du persona. Inclus :
- Nom du persona / handle
- Plateformes cibles
- Site web (si applicable)
- Description en 1-2 phrases de qui est ce persona

Format Markdown.`,

  tone: `Génère la section TON & PERSONNALITÉ du persona. Inclus :
- Tutoiement ou vouvoiement
- Type d'humour (avec pourcentages)
- Traits de personnalité principaux (avec pourcentages)
- Comment le persona parle de son produit/projet

Format Markdown.`,

  vocabulary: `Génère la section VOCABULAIRE du persona. Inclus :
- Expressions récurrentes (5-10)
- Mots INTERDITS (5-10, typiquement le jargon marketing)
- Emojis autorisés (5-8)
- Emojis interdits (3-5)
- Règle du 4e mur (ne jamais dire qu'on est une IA, etc.)

Format Markdown.`,

  art_direction: `Génère la section DIRECTION ARTISTIQUE du persona. Inclus :
- Palette de couleurs (6-8 couleurs avec hex codes)
- Règles d'application (carrousels, overlays, etc.)
- Ambiance / mood en une phrase

Format Markdown.`,

  examples: `Génère 4 EXEMPLES DE VOIX pour le persona. Inclus :
- 1 post TikTok (trend/réaction)
- 1 caption Instagram (carrousel tuto)
- 1 story Instagram (question/sondage)
- 1 réponse à un commentaire

Chaque exemple doit être prêt à publier, dans le ton exact du persona.

Format Markdown.`,
};

function buildSystemPrompt(session: WizardSession): string {
  return [
    'Tu es un expert en personal branding et création de personas pour les réseaux sociaux.',
    `Le projet : ${session.data.projectDescription ?? ''}`,
    `Niche : ${session.data.projectNiche ?? ''}`,
    `Langue : ${session.data.projectLanguage ?? 'fr'}`,
    `Ton choisi : ${session.data.personaTone ?? 'sarcastique/taquin'}`,
    '',
    'Génère du contenu en français sauf indication contraire.',
    'Le persona doit être authentique, pas corporate.',
  ].join('\n');
}

/**
 * Build the tone selection prompt (before generating persona sections).
 */
export function buildToneSelection(session: WizardSession): V2MessagePayload {
  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🎭 Persona — Étape ${getStepLabel(session.step)}`,
      '',
      'Quel ton veux-tu pour ton persona ?',
      '',
      '1. 😏 **Sarcastique/taquin** — comme un pote',
      '2. 📚 **Expert/pédagogue** — le prof cool',
      '3. 🔥 **Hype/énergique** — le streamer',
      '4. 🎩 **Mystérieux/narratif** — le conteur',
      '',
      'Tu peux aussi décrire ton propre ton.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:tone:sarcastic', 'Sarcastique', ButtonStyle.Secondary, '😏'),
      btn('wizard:tone:expert', 'Expert', ButtonStyle.Secondary, '📚'),
      btn('wizard:tone:hype', 'Hype', ButtonStyle.Secondary, '🔥'),
      btn('wizard:tone:mysterious', 'Mystérieux', ButtonStyle.Secondary, '🎩'),
    ));
  })]);
}

const TONE_MAP: Record<string, string> = {
  sarcastic: 'Sarcastique/taquin, comme un pote. Humour acide mais jamais méchant.',
  expert: 'Expert/pédagogue, le prof cool qui vulgarise avec passion.',
  hype: 'Hype/énergique, le streamer survolté qui célèbre tout.',
  mysterious: 'Mystérieux/narratif, le conteur qui maintient le suspense.',
};

export function setTone(session: WizardSession, toneKey: string): void {
  session.data.personaTone = TONE_MAP[toneKey] ?? toneKey;
}

/**
 * Generate one section of the persona.
 */
export async function generatePersonaSection(
  session: WizardSession,
  section: PersonaSection,
): Promise<V2MessagePayload> {
  const systemPrompt = buildSystemPrompt(session);
  const sectionPrompt = SECTION_PROMPTS[section];

  addToHistory(session, 'user', `Génère la section : ${SECTION_LABELS[section]}`);

  const response = await complete(systemPrompt, sectionPrompt, {
    maxTokens: 1500,
    temperature: 0.8,
  });

  recordIteration(session, response.tokensIn, response.tokensOut);
  addToHistory(session, 'assistant', response.text);

  // Store in session data
  const sectionDataKey = `persona${section.charAt(0).toUpperCase()}${section.slice(1).replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}` as keyof typeof session.data;
  (session.data as Record<string, unknown>)[sectionDataKey] = response.text;

  const label = SECTION_LABELS[section];

  return v2([buildContainer(getColor('primary'), (c) => {
    // Truncate for display if too long
    const preview = response.text.length > 1500
      ? response.text.slice(0, 1500) + '\n\n*(...tronqué pour l\'affichage)*'
      : response.text;

    c.addTextDisplayComponents(txt([
      `## ${label} — Étape ${getStepLabel(session.step)}`,
      '',
      preview,
      '',
      `*Tokens : ${String(session.tokensUsed)} · Itérations : ${String(session.iterationCount)}/20*`,
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
      btn('wizard:redo', 'Régénérer', ButtonStyle.Secondary, '🔄'),
      btn('wizard:modify', 'Modifier', ButtonStyle.Primary, '✏️'),
    ));
  })]);
}

/**
 * Assemble the full persona from all sections.
 */
export function assemblePersona(session: WizardSession): string {
  const sections = [
    session.data.personaIdentity,
    session.data.personaToneSection,
    session.data.personaVocabulary,
    session.data.personaArtDirection,
    session.data.personaExamples,
  ].filter((s): s is string => s !== undefined && s.length > 0);

  const full = sections.join('\n\n---\n\n');
  session.data.personaFull = full;
  return full;
}
