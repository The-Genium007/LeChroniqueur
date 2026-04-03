/**
 * Registry of LLM providers, their models, pricing, and configuration.
 * Source of truth for the provider selection UI and cost calculations.
 */

// ─── Types ───

export type ClientType = 'anthropic' | 'openai' | 'openai_compatible';

export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly clientType: ClientType;
  readonly baseUrl?: string;
  readonly requiresBaseUrl: boolean;
  readonly models: readonly LlmModel[];
  readonly allowCustomModel: boolean;
  readonly description: string;
}

export interface LlmModel {
  readonly id: string;
  readonly name: string;
  readonly inputCostPerMillion: number;   // cents per 1M tokens
  readonly outputCostPerMillion: number;  // cents per 1M tokens
  readonly contextWindow: number;
  readonly description: string;
}

export interface LlmProviderConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly clientType: ClientType;
}

// ─── Default cost for unknown models ───

const DEFAULT_PRICING: Pick<LlmModel, 'inputCostPerMillion' | 'outputCostPerMillion'> = {
  inputCostPerMillion: 100,
  outputCostPerMillion: 500,
};

// ─── Provider Registry ───

const PROVIDERS: readonly LlmProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    emoji: '🟠',
    clientType: 'anthropic',
    requiresBaseUrl: false,
    allowCustomModel: false,
    description: 'Claude — meilleur en rédaction créative et analyse',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', inputCostPerMillion: 500, outputCostPerMillion: 2500, contextWindow: 1_000_000, description: 'Le plus puissant, reasoning avancé' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', inputCostPerMillion: 300, outputCostPerMillion: 1500, contextWindow: 1_000_000, description: 'Équilibré qualité/prix (recommandé)' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', inputCostPerMillion: 100, outputCostPerMillion: 500, contextWindow: 200_000, description: 'Rapide et économique' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI (GPT)',
    emoji: '🟢',
    clientType: 'openai',
    requiresBaseUrl: false,
    allowCustomModel: false,
    description: 'GPT — polyvalent et performant',
    models: [
      { id: 'gpt-5-4', name: 'GPT-5.4', inputCostPerMillion: 60, outputCostPerMillion: 240, contextWindow: 128_000, description: 'Dernier modèle, rapide' },
      { id: 'gpt-5-2', name: 'GPT-5.2', inputCostPerMillion: 175, outputCostPerMillion: 1400, contextWindow: 128_000, description: 'Flagship, haute qualité' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', inputCostPerMillion: 25, outputCostPerMillion: 200, contextWindow: 128_000, description: 'Bon rapport qualité/prix' },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano', inputCostPerMillion: 5, outputCostPerMillion: 40, contextWindow: 128_000, description: 'Le moins cher' },
    ],
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    emoji: '🔵',
    clientType: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    requiresBaseUrl: false,
    allowCustomModel: false,
    description: 'Gemini — grand contexte et multimodal',
    models: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', inputCostPerMillion: 125, outputCostPerMillion: 1000, contextWindow: 1_000_000, description: 'Avancé, reasoning' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', inputCostPerMillion: 125, outputCostPerMillion: 1000, contextWindow: 1_000_000, description: 'Reasoning complexe' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', inputCostPerMillion: 30, outputCostPerMillion: 250, contextWindow: 128_000, description: 'Rapide et économique' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    emoji: '🟣',
    clientType: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1/',
    requiresBaseUrl: false,
    allowCustomModel: false,
    description: 'Mistral — modèles européens performants',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large 3', inputCostPerMillion: 200, outputCostPerMillion: 600, contextWindow: 128_000, description: 'Flagship, state-of-the-art' },
      { id: 'mistral-small-latest', name: 'Mistral Small 4', inputCostPerMillion: 10, outputCostPerMillion: 30, contextWindow: 128_000, description: 'Très économique' },
      { id: 'devstral-latest', name: 'Devstral 2', inputCostPerMillion: 20, outputCostPerMillion: 60, contextWindow: 128_000, description: 'Spécialisé code' },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    emoji: '🐋',
    clientType: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com/v1/',
    requiresBaseUrl: false,
    allowCustomModel: false,
    description: 'DeepSeek — ultra économique, très bon en raisonnement',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', inputCostPerMillion: 27, outputCostPerMillion: 110, contextWindow: 64_000, description: 'Meilleur rapport qualité/prix' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', inputCostPerMillion: 55, outputCostPerMillion: 219, contextWindow: 64_000, description: 'Reasoning avancé' },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    emoji: '⚡',
    clientType: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1/',
    requiresBaseUrl: false,
    allowCustomModel: false,
    description: 'Grok — rapide et performant',
    models: [
      { id: 'grok-3-beta', name: 'Grok 3', inputCostPerMillion: 200, outputCostPerMillion: 800, contextWindow: 128_000, description: 'Flagship avec reasoning' },
      { id: 'grok-3-mini-beta', name: 'Grok 3 Mini', inputCostPerMillion: 30, outputCostPerMillion: 50, contextWindow: 131_000, description: 'Lightweight, rapide' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    emoji: '🚀',
    clientType: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1/',
    requiresBaseUrl: false,
    allowCustomModel: true,
    description: 'Groq — inférence ultra-rapide sur modèles open-source',
    models: [
      { id: 'meta-llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', inputCostPerMillion: 4, outputCostPerMillion: 4, contextWindow: 128_000, description: 'Llama 4, très rapide' },
      { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 70B', inputCostPerMillion: 75, outputCostPerMillion: 99, contextWindow: 128_000, description: 'Reasoning via Groq' },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    emoji: '🤝',
    clientType: 'openai_compatible',
    baseUrl: 'https://api.together.xyz/v1/',
    requiresBaseUrl: false,
    allowCustomModel: true,
    description: 'Together — 200+ modèles open-source',
    models: [
      { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8', name: 'Llama 4 Maverick', inputCostPerMillion: 27, outputCostPerMillion: 85, contextWindow: 1_000_000, description: 'Flagship open-source' },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', inputCostPerMillion: 50, outputCostPerMillion: 150, contextWindow: 64_000, description: 'Via Together' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    emoji: '🌐',
    clientType: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1/',
    requiresBaseUrl: false,
    allowCustomModel: true,
    description: 'OpenRouter — gateway vers 200+ modèles, une seule clé',
    models: [
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (via OR)', inputCostPerMillion: 300, outputCostPerMillion: 1500, contextWindow: 200_000, description: 'Claude via OpenRouter' },
      { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini (via OR)', inputCostPerMillion: 25, outputCostPerMillion: 200, contextWindow: 128_000, description: 'GPT via OpenRouter' },
      { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3 (via OR)', inputCostPerMillion: 27, outputCostPerMillion: 110, contextWindow: 64_000, description: 'DeepSeek via OpenRouter' },
    ],
  },
  {
    id: 'litellm',
    name: 'LiteLLM (self-hosted)',
    emoji: '🔧',
    clientType: 'openai_compatible',
    requiresBaseUrl: true,
    allowCustomModel: true,
    description: 'LiteLLM — proxy self-hosted, 100+ providers',
    models: [],
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    emoji: '⚙️',
    clientType: 'openai_compatible',
    requiresBaseUrl: true,
    allowCustomModel: true,
    description: 'Tout endpoint OpenAI-compatible',
    models: [],
  },
];

// ─── Public API ───

export function getAllProviders(): readonly LlmProvider[] {
  return PROVIDERS;
}

export function getProvider(id: string): LlmProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getProviderModels(providerId: string): readonly LlmModel[] {
  return getProvider(providerId)?.models ?? [];
}

export function getModel(providerId: string, modelId: string): LlmModel | undefined {
  return getProviderModels(providerId).find((m) => m.id === modelId);
}

export function getClientType(providerId: string): ClientType {
  return getProvider(providerId)?.clientType ?? 'openai_compatible';
}

export function getBaseUrl(providerId: string): string | undefined {
  return getProvider(providerId)?.baseUrl;
}

/**
 * Returns the cost in cents for a given LLM call.
 * Falls back to default pricing for unknown models.
 */
export function computeLlmCostCents(
  providerId: string,
  modelId: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const model = getModel(providerId, modelId);

  const inputRate = model?.inputCostPerMillion ?? DEFAULT_PRICING.inputCostPerMillion;
  const outputRate = model?.outputCostPerMillion ?? DEFAULT_PRICING.outputCostPerMillion;

  const inputCost = (tokensIn / 1_000_000) * inputRate;
  const outputCost = (tokensOut / 1_000_000) * outputRate;

  return Math.ceil(inputCost + outputCost);
}

/**
 * Builds a LlmProviderConfig from stored secrets.
 */
export function buildProviderConfig(
  providerId: string,
  modelId: string,
  apiKey: string,
  customBaseUrl?: string,
): LlmProviderConfig {
  const provider = getProvider(providerId);
  const clientType = provider?.clientType ?? 'openai_compatible';
  const baseUrl = customBaseUrl ?? provider?.baseUrl;

  const config: LlmProviderConfig = {
    provider: providerId,
    model: modelId,
    apiKey,
    clientType,
  };

  if (baseUrl !== undefined) {
    return { ...config, baseUrl };
  }

  return config;
}
