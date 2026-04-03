import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
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
L'utilisateur te fournit des informations structurées sur son projet. Tu dois analyser et proposer :
1. Un nom court pour l'instance (slug, 2-3 mots max, lowercase, tirets)
2. La niche/domaine principal (reformulée clairement)
3. La langue principale du contenu
4. Les plateformes cibles

Réponds en JSON :
{"instanceName": "...", "niche": "...", "language": "fr", "platforms": ["tiktok", "instagram"]}`;

/**
 * Build the initial "describe your project" prompt with a button to open the modal.
 */
export function buildDescribePrompt(session: WizardSession): V2MessagePayload {
  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🤖 Wizard IA — Étape ${getStepLabel(session.step)}`,
      '',
      '**Décris ton projet pour que je puisse configurer ta veille.**',
      '',
      'Clique sur le bouton ci-dessous pour remplir les informations de ton projet.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:describe:modal', 'Remplir les infos projet', ButtonStyle.Primary, '📋'),
    ));
  })]);
}

/**
 * Build the modal for structured project description (5 fields).
 */
export function buildDescribeModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('wizard:modal:describe')
    .setTitle('Décris ton projet')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('project_name')
          .setLabel('Nom du projet / marque')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Mon Projet')
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('project_url')
          .setLabel('Site web (optionnel)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('https://monprojet.com')
          .setRequired(false)
          .setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('project_niche')
          .setLabel('Ta niche en une phrase')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Coaching fitness, cuisine vegan, tech startup...')
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('project_content_types')
          .setLabel('Types de contenu que tu publies')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('News, tutos, opinions, memes, reviews')
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('project_platforms')
          .setLabel('Plateformes cibles')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('TikTok, Instagram, YouTube, X')
          .setRequired(true)
          .setMaxLength(200),
      ),
    );
}

/**
 * Process the modal submission — extract structured data + LLM analysis.
 */
export async function processDescribeModal(
  session: WizardSession,
  fields: {
    projectName: string;
    projectUrl: string;
    projectNiche: string;
    contentTypes: string;
    platforms: string;
  },
): Promise<{
  analysis: { instanceName: string; niche: string; language: string; platforms: string[] };
  message: V2MessagePayload;
}> {
  const logger = getLogger();

  // Parse content types and platforms from comma-separated strings
  const contentTypes = fields.contentTypes.split(/[,;]/).map((s) => s.trim()).filter((s) => s.length > 0);
  const platformsList = fields.platforms.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);

  // Store raw data immediately
  session.data.projectName = fields.projectName;
  if (fields.projectUrl.length > 0) {
    session.data.projectUrl = fields.projectUrl;
  }
  session.data.projectNiche = fields.projectNiche;
  session.data.contentTypes = contentTypes;
  session.data.projectPlatforms = platformsList;

  // Build description for LLM analysis
  const description = [
    `Projet : ${fields.projectName}`,
    fields.projectUrl.length > 0 ? `Site web : ${fields.projectUrl}` : '',
    `Niche : ${fields.projectNiche}`,
    `Types de contenu : ${fields.contentTypes}`,
    `Plateformes : ${fields.platforms}`,
  ].filter((l) => l.length > 0).join('\n');

  session.data.projectDescription = description;
  addToHistory(session, 'user', description);

  // LLM analysis for instanceName and language detection
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
    logger.warn({ parseError, rawText: response.text.slice(0, 300) }, 'Failed to parse Claude analysis, using modal data');
    analysis = {
      instanceName: fields.projectName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      niche: fields.projectNiche,
      language: 'fr',
      platforms: platformsList,
    };
  }

  // Update session with LLM-refined data
  session.data.projectLanguage = analysis.language ?? 'fr';
  session.data.instanceName = (analysis.instanceName ?? fields.projectName)
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  addToHistory(session, 'assistant', response.text);

  const message = v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🤖 Wizard IA — Étape ${getStepLabel(session.step)}`,
      '',
      'J\'ai analysé ton projet. Voici ce que je propose :',
      '',
      `🏷️ **Nom** : ${fields.projectName}`,
      `🎯 **Niche** : ${analysis.niche}`,
      fields.projectUrl.length > 0 ? `🌐 **Site** : ${fields.projectUrl}` : '',
      `📱 **Plateformes** : ${analysis.platforms.join(', ')}`,
      `📝 **Contenu** : ${contentTypes.join(', ')}`,
      `🗣️ **Langue** : ${analysis.language}`,
      '',
      'Tu valides ? On passe aux questions de suivi pour affiner ta veille.',
    ].filter((l) => l.length > 0).join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
      btn('wizard:modify', 'Modifier', ButtonStyle.Primary, '✏️'),
      btn('wizard:redo', 'Régénérer', ButtonStyle.Secondary, '🔄'),
    ));
  })]);

  return { analysis, message };
}
