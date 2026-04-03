import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { ApiNotConfiguredError, ApiOverloadedError, classifyApiError } from './api-errors.js';

export interface AnthropicResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface CompletionOptions {
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
}

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  // Check if the API key changed (e.g. set during wizard onboarding)
  const config = getConfig();
  const currentKey = process.env['ANTHROPIC_API_KEY'] ?? config.ANTHROPIC_API_KEY;

  if (currentKey.length === 0) {
    throw new ApiNotConfiguredError('anthropic');
  }

  if (_client !== undefined && _lastKey === currentKey) {
    return _client;
  }

  _client = new Anthropic({ apiKey: currentKey });
  _lastKey = currentKey;
  return _client;
}

let _lastKey: string | undefined;

export async function complete(
  systemPrompt: string,
  userMessage: string,
  options?: CompletionOptions,
): Promise<AnthropicResponse> {
  const config = getConfig();
  const logger = getLogger();

  if (config.MOCK_APIS) {
    const { mockCompleteResponse } = await import('../dev/fixtures.js');
    logger.debug('MOCK Anthropic complete');
    return { text: mockCompleteResponse(userMessage), tokensIn: 500, tokensOut: 200 };
  }

  const client = getClient();

  logger.debug(
    { model: config.ANTHROPIC_MODEL, systemLength: systemPrompt.length },
    'Anthropic API call',
  );

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const message = await client.messages.create({
        model: config.ANTHROPIC_MODEL,
        max_tokens: options?.maxTokens ?? 2048,
        temperature: options?.temperature ?? 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const textBlocks = message.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      const text = textBlocks.map((block) => block.text).join('');

      const result: AnthropicResponse = {
        text,
        tokensIn: message.usage.input_tokens,
        tokensOut: message.usage.output_tokens,
      };

      logger.debug(
        { tokensIn: result.tokensIn, tokensOut: result.tokensOut },
        'Anthropic response received',
      );

      return result;
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

export async function completeWithSearch(
  systemPrompt: string,
  userMessage: string,
  options?: CompletionOptions,
): Promise<AnthropicResponse> {
  const config = getConfig();
  const logger = getLogger();
  const client = getClient();

  logger.debug('Anthropic API call with web_search');

  const message = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0.7,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [
      // The web_search tool uses a server-side type not in the SDK's Tool union.
      // We cast through unknown to satisfy the type checker.
      {
        name: 'web_search',
        type: 'web_search_20250305',
      } as unknown as Anthropic.Messages.Tool,
    ],
  });

  const textBlocks = message.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text',
  );

  const text = textBlocks.map((block) => block.text).join('');

  return {
    text,
    tokensIn: message.usage.input_tokens,
    tokensOut: message.usage.output_tokens,
  };
}
