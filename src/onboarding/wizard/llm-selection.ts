import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder as ModalActionRow,
} from 'discord.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession } from './state-machine.js';
import { getAllProviders, getProviderModels, getProvider, getBaseUrl } from '../../services/llm-providers.js';

// ─── Step 1: Provider selection ───

/**
 * Builds the LLM provider selection UI.
 * Shows all available providers as buttons grouped in rows of 3.
 */
export function buildProviderSelection(session: WizardSession): V2MessagePayload {
  const selectedProvider = (session.data as Record<string, unknown>)['_llmProvider'] as string | undefined;
  const providers = getAllProviders();

  const statusLines = providers.map((p) => {
    const isSelected = p.id === selectedProvider;
    return isSelected ? `✅ ${p.emoji} **${p.name}**` : `${p.emoji} ${p.name} — _${p.description}_`;
  });

  // Build provider buttons in rows of 3
  const providerRows: ReturnType<typeof row>[] = [];
  for (let i = 0; i < providers.length; i += 3) {
    const chunk = providers.slice(i, i + 3);
    const buttons = chunk.map((p) => {
      const isSelected = p.id === selectedProvider;
      return btn(
        `wizard:llm:provider:${p.id}`,
        p.name.length > 20 ? p.id : p.name,
        isSelected ? ButtonStyle.Success : ButtonStyle.Secondary,
        p.emoji,
      );
    });
    providerRows.push(row(...buttons));
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      '## 🤖 Provider IA — Choix du fournisseur',
      '',
      'Choisis le fournisseur d\'IA pour la génération de texte (veille, suggestions, dérivations).',
      '',
      statusLines.join('\n'),
    ].join('\n')));
    c.addSeparatorComponents(sep());
    for (const r of providerRows) {
      c.addActionRowComponents(r);
    }
  })]);
}

// ─── Step 2: Model selection ───

/**
 * Builds the model selection UI for the chosen provider.
 * Shows predefined models as buttons, or a text input for custom model ID.
 */
export function buildModelSelection(session: WizardSession): V2MessagePayload {
  const providerId = (session.data as Record<string, unknown>)['_llmProvider'] as string;
  const selectedModel = (session.data as Record<string, unknown>)['_llmModel'] as string | undefined;
  const provider = getProvider(providerId);

  if (provider === undefined) {
    return v2([buildContainer(getColor('error'), (c) => {
      c.addTextDisplayComponents(txt('❌ Provider non trouvé. Retourne en arrière.'));
    })]);
  }

  const models = getProviderModels(providerId);

  // If provider allows custom model and has no predefined models, show input
  if (provider.allowCustomModel && models.length === 0) {
    return v2([buildContainer(getColor('primary'), (c) => {
      c.addTextDisplayComponents(txt([
        `## 🤖 ${provider.emoji} ${provider.name} — Model ID`,
        '',
        'Ce provider accepte un Model ID personnalisé.',
        'Clique ci-dessous pour entrer le Model ID.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:llm:model:custom', 'Entrer le Model ID', ButtonStyle.Primary, '✏️'),
        btn('wizard:llm:back', 'Changer de provider', ButtonStyle.Secondary, '⬅️'),
      ));
    })]);
  }

  // Show predefined models as buttons
  const modelLines = models.map((m) => {
    const isSelected = m.id === selectedModel;
    const costStr = `${String(m.inputCostPerMillion)}¢/$1M in · ${String(m.outputCostPerMillion)}¢/$1M out`;
    return isSelected
      ? `✅ **${m.name}** — ${costStr}`
      : `⬜ **${m.name}** — _${m.description}_ (${costStr})`;
  });

  const modelRows: ReturnType<typeof row>[] = [];
  for (let i = 0; i < models.length; i += 3) {
    const chunk = models.slice(i, i + 3);
    const buttons = chunk.map((m) => {
      const isSelected = m.id === selectedModel;
      return btn(
        `wizard:llm:model:${m.id}`,
        m.name.length > 20 ? m.id.slice(0, 20) : m.name,
        isSelected ? ButtonStyle.Success : ButtonStyle.Secondary,
      );
    });
    modelRows.push(row(...buttons));
  }

  const actionButtons = [
    btn('wizard:llm:next', 'Continuer', ButtonStyle.Success, '✅'),
    btn('wizard:llm:back', 'Changer de provider', ButtonStyle.Secondary, '⬅️'),
  ];

  // Add custom model option if provider supports it
  if (provider.allowCustomModel) {
    actionButtons.push(
      btn('wizard:llm:model:custom', 'Model ID custom', ButtonStyle.Primary, '✏️'),
    );
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🤖 ${provider.emoji} ${provider.name} — Choix du modèle`,
      '',
      'Sélectionne le modèle à utiliser :',
      '',
      modelLines.join('\n'),
    ].join('\n')));
    c.addSeparatorComponents(sep());
    for (const r of modelRows) {
      c.addActionRowComponents(r);
    }
    c.addActionRowComponents(row(...actionButtons));
  })]);
}

// ─── Step 3: API Key modal ───

/**
 * Builds the modal for entering the API key.
 * Adapts fields based on the provider (some need base URL).
 */
export function buildApiKeyModal(session: WizardSession): ModalBuilder {
  const providerId = (session.data as Record<string, unknown>)['_llmProvider'] as string;
  const provider = getProvider(providerId);

  const modal = new ModalBuilder()
    .setCustomId('wizard:modal:llm:apikey')
    .setTitle(`Clé API — ${provider?.name ?? providerId}`);

  // API Key field (always present)
  const keyInput = new TextInputBuilder()
    .setCustomId('llm_api_key')
    .setLabel('Clé API')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(getKeyPlaceholder(providerId));

  modal.addComponents(
    new ModalActionRow<TextInputBuilder>().addComponents(keyInput),
  );

  // Base URL field (for providers that need it)
  if (provider?.requiresBaseUrl === true) {
    const defaultUrl = getBaseUrl(providerId) ?? '';
    const urlInput = new TextInputBuilder()
      .setCustomId('llm_base_url')
      .setLabel('Base URL')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('https://...')
      .setValue(defaultUrl);

    modal.addComponents(
      new ModalActionRow<TextInputBuilder>().addComponents(urlInput),
    );
  }

  return modal;
}

/**
 * Builds a modal for custom model ID input.
 */
export function buildCustomModelModal(session: WizardSession): ModalBuilder {
  const providerId = (session.data as Record<string, unknown>)['_llmProvider'] as string;
  const provider = getProvider(providerId);

  const modal = new ModalBuilder()
    .setCustomId('wizard:modal:llm:custom_model')
    .setTitle(`Model ID — ${provider?.name ?? providerId}`);

  const modelInput = new TextInputBuilder()
    .setCustomId('llm_model_id')
    .setLabel('Model ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('ex: claude-sonnet-4-6, gpt-5-mini, etc.');

  modal.addComponents(
    new ModalActionRow<TextInputBuilder>().addComponents(modelInput),
  );

  // Also add base URL if provider needs it
  if (provider?.requiresBaseUrl === true) {
    const defaultUrl = getBaseUrl(providerId) ?? '';
    const urlInput = new TextInputBuilder()
      .setCustomId('llm_base_url')
      .setLabel('Base URL')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('https://...')
      .setValue(defaultUrl);

    modal.addComponents(
      new ModalActionRow<TextInputBuilder>().addComponents(urlInput),
    );
  }

  return modal;
}

// ─── Step 4: Validation result ───

/**
 * Builds the validation result UI after testing the API key.
 */
export function buildValidationResult(
  success: boolean,
  providerName: string,
  modelName: string,
): V2MessagePayload {
  if (success) {
    return v2([buildContainer(getColor('success'), (c) => {
      c.addTextDisplayComponents(txt([
        '## ✅ Clé API validée !',
        '',
        `**Provider** : ${providerName}`,
        `**Modèle** : ${modelName}`,
        '',
        'L\'IA est prête. On continue la configuration.',
      ].join('\n')));
      c.addSeparatorComponents(sep());
      c.addActionRowComponents(row(
        btn('wizard:llm:confirmed', 'Continuer', ButtonStyle.Success, '✅'),
        btn('wizard:llm:back', 'Changer de provider', ButtonStyle.Secondary, '⬅️'),
      ));
    })]);
  }

  return v2([buildContainer(getColor('error'), (c) => {
    c.addTextDisplayComponents(txt([
      '## ❌ Clé API invalide',
      '',
      `**Provider** : ${providerName}`,
      `**Modèle** : ${modelName}`,
      '',
      'Vérifie ta clé API et réessaie.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:llm:retry', 'Réessayer', ButtonStyle.Primary, '🔄'),
      btn('wizard:llm:back', 'Changer de provider', ButtonStyle.Secondary, '⬅️'),
    ));
  })]);
}

// ─── Helpers ───

function getKeyPlaceholder(providerId: string): string {
  switch (providerId) {
    case 'anthropic': return 'sk-ant-api03-...';
    case 'openai': return 'sk-...';
    case 'google': return 'AIza...';
    case 'mistral': return 'mist-...';
    case 'deepseek': return 'sk-...';
    case 'xai': return 'xai-...';
    case 'groq': return 'gsk_...';
    case 'together': return 'tog-...';
    case 'openrouter': return 'sk-or-...';
    default: return 'your-api-key';
  }
}

/**
 * Stores the selected provider in wizard session data.
 */
export function setLlmProvider(session: WizardSession, providerId: string): void {
  (session.data as Record<string, unknown>)['_llmProvider'] = providerId;
  // Reset model when provider changes
  (session.data as Record<string, unknown>)['_llmModel'] = undefined;
}

/**
 * Stores the selected model in wizard session data.
 */
export function setLlmModel(session: WizardSession, modelId: string): void {
  (session.data as Record<string, unknown>)['_llmModel'] = modelId;
}

/**
 * Stores the API key in wizard session data.
 */
export function setLlmApiKey(session: WizardSession, apiKey: string): void {
  (session.data as Record<string, unknown>)['_llmApiKey'] = apiKey;
}

/**
 * Stores the base URL in wizard session data.
 */
export function setLlmBaseUrl(session: WizardSession, baseUrl: string): void {
  (session.data as Record<string, unknown>)['_llmBaseUrl'] = baseUrl;
}

/**
 * Retrieves the full LLM config from wizard session.
 */
export function getLlmSessionConfig(session: WizardSession): {
  provider: string | undefined;
  model: string | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
} {
  const data = session.data as Record<string, unknown>;
  return {
    provider: data['_llmProvider'] as string | undefined,
    model: data['_llmModel'] as string | undefined,
    apiKey: data['_llmApiKey'] as string | undefined,
    baseUrl: data['_llmBaseUrl'] as string | undefined,
  };
}
