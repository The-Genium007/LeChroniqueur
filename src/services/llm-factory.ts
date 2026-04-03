import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getLogger } from '../core/logger.js';
import { getConfig } from '../core/config.js';
import { ApiNotConfiguredError, ApiOverloadedError, classifyApiError } from './api-errors.js';
import { type LlmProviderConfig, buildProviderConfig } from './llm-providers.js';

// ─── Types ───

export interface LlmResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly provider: string;
  readonly model: string;
}

export interface LlmCompletionOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

// ─── Singleton state ───

let _providerConfig: LlmProviderConfig | undefined;
let _anthropicClient: Anthropic | undefined;
let _openaiClient: OpenAI | undefined;

// ─── Initialization ───

/**
 * Initialize the LLM factory with a provider configuration.
 * Called once at boot from stored secrets.
 */
export function initLlmFactory(config: LlmProviderConfig): void {
  const logger = getLogger();

  _providerConfig = config;
  _anthropicClient = undefined;
  _openaiClient = undefined;

  logger.info(
    { provider: config.provider, model: config.model, clientType: config.clientType },
    'LLM factory initialized',
  );
}

/**
 * Initialize from legacy env vars (backward compatibility).
 */
export function initLlmFactoryFromEnv(): void {
  const config = getConfig();

  const provider = process.env['LLM_PROVIDER'] ?? 'anthropic';
  const model = process.env['LLM_MODEL'] ?? config.ANTHROPIC_MODEL;
  const apiKey = process.env['LLM_API_KEY'] ?? config.ANTHROPIC_API_KEY;
  const baseUrl = process.env['LLM_BASE_URL'];

  if (apiKey.length === 0) {
    return; // Not configured yet — will be set during onboarding
  }

  const providerConfig = buildProviderConfig(provider, model, apiKey, baseUrl);
  initLlmFactory(providerConfig);
}

/**
 * Returns the current provider config (or undefined if not initialized).
 */
export function getLlmConfig(): LlmProviderConfig | undefined {
  return _providerConfig;
}

// ─── Client getters ───

function getAnthropicClient(): Anthropic {
  if (_providerConfig === undefined) {
    throw new ApiNotConfiguredError('llm');
  }

  if (_anthropicClient !== undefined) {
    return _anthropicClient;
  }

  _anthropicClient = new Anthropic({ apiKey: _providerConfig.apiKey });
  return _anthropicClient;
}

function getOpenAiClient(): OpenAI {
  if (_providerConfig === undefined) {
    throw new ApiNotConfiguredError('llm');
  }

  if (_openaiClient !== undefined) {
    return _openaiClient;
  }

  const options: { apiKey: string; baseURL?: string } = {
    apiKey: _providerConfig.apiKey,
  };

  if (_providerConfig.baseUrl !== undefined) {
    options.baseURL = _providerConfig.baseUrl;
  }

  _openaiClient = new OpenAI(options);
  return _openaiClient;
}

// ─── Main completion function ───

/**
 * Unified LLM completion that routes to the correct provider.
 * Drop-in replacement for the Anthropic-specific `complete()`.
 */
export async function complete(
  systemPrompt: string,
  userMessage: string,
  options?: LlmCompletionOptions,
): Promise<LlmResponse> {
  const config = getConfig();

  if (config.MOCK_APIS) {
    const { mockCompleteResponse } = await import('../dev/fixtures.js');
    return {
      text: mockCompleteResponse(userMessage),
      tokensIn: 500,
      tokensOut: 200,
      provider: _providerConfig?.provider ?? 'mock',
      model: _providerConfig?.model ?? 'mock',
    };
  }

  if (_providerConfig === undefined) {
    throw new ApiNotConfiguredError('llm');
  }

  switch (_providerConfig.clientType) {
    case 'anthropic':
      return completeViaAnthropic(systemPrompt, userMessage, options);

    case 'openai':
    case 'openai_compatible':
      return completeViaOpenAi(systemPrompt, userMessage, options);
  }
}

// ─── Anthropic implementation ───

async function completeViaAnthropic(
  systemPrompt: string,
  userMessage: string,
  options?: LlmCompletionOptions,
): Promise<LlmResponse> {
  const logger = getLogger();
  const client = getAnthropicClient();
  const model = _providerConfig?.model ?? 'claude-sonnet-4-6';

  logger.debug({ model, systemLength: systemPrompt.length }, 'LLM call (Anthropic)');

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const message = await client.messages.create({
        model,
        max_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const textBlocks = message.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      return {
        text: textBlocks.map((block) => block.text).join(''),
        tokensIn: message.usage.input_tokens,
        tokensOut: message.usage.output_tokens,
        provider: 'anthropic',
        model,
      };
    } catch (error) {
      const classified = classifyApiError('anthropic', error);
      lastError = classified;

      if (classified instanceof ApiOverloadedError && attempt < maxRetries) {
        const delayMs = attempt * 3000;
        logger.warn({ attempt, maxRetries, delayMs }, 'Anthropic overloaded, retrying');
        await new Promise((resolve) => { setTimeout(resolve, delayMs); });
        continue;
      }

      throw classified;
    }
  }

  throw lastError;
}

// ─── OpenAI / OpenAI-compatible implementation ───

async function completeViaOpenAi(
  systemPrompt: string,
  userMessage: string,
  options?: LlmCompletionOptions,
): Promise<LlmResponse> {
  const logger = getLogger();
  const client = getOpenAiClient();
  const model = _providerConfig?.model ?? 'gpt-5-mini';
  const provider = _providerConfig?.provider ?? 'openai';

  logger.debug({ model, provider, systemLength: systemPrompt.length }, 'LLM call (OpenAI-compatible)');

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model,
        max_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });

      const text = completion.choices[0]?.message.content ?? '';

      return {
        text,
        tokensIn: completion.usage?.prompt_tokens ?? 0,
        tokensOut: completion.usage?.completion_tokens ?? 0,
        provider,
        model,
      };
    } catch (error) {
      lastError = error;

      // Retry on rate limit / overloaded
      const isRetryable = error instanceof Error && (
        error.message.includes('429') ||
        error.message.includes('overloaded') ||
        error.message.includes('rate_limit')
      );

      if (isRetryable && attempt < maxRetries) {
        const delayMs = attempt * 3000;
        logger.warn({ attempt, maxRetries, delayMs, provider }, 'Provider rate limited, retrying');
        await new Promise((resolve) => { setTimeout(resolve, delayMs); });
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}
