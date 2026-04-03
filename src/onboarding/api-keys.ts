import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { encrypt } from '../core/crypto.js';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { getProvider, type ClientType } from '../services/llm-providers.js';

/**
 * Validate an Anthropic API key by making a minimal API call.
 * Uses Haiku for minimal cost (~$0.0001).
 */
export async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  const logger = getLogger();

  try {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    logger.info('Anthropic API key validated successfully');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Anthropic API key validation failed');
    return false;
  }
}

/**
 * Validate a Google Cloud API key.
 * Tests both Generative AI (Imagen/Veo) and YouTube Data API v3.
 * Returns which APIs are accessible with this key.
 */
export async function validateGoogleCloudKey(apiKey: string): Promise<{ generativeAi: boolean; youtubeData: boolean }> {
  const logger = getLogger();

  const results = { generativeAi: false, youtubeData: false };

  // Test Generative AI API
  try {
    const genResponse = await fetch(
      'https://generativelanguage.googleapis.com/v1/models',
      {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    results.generativeAi = genResponse.ok;
    if (results.generativeAi) {
      logger.info('Google Cloud key: Generative AI API accessible');
    } else {
      logger.warn({ status: genResponse.status }, 'Google Cloud key: Generative AI API not accessible');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Google Cloud key: Generative AI test failed');
  }

  // Test YouTube Data API v3
  try {
    const ytResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=id&id=dQw4w9WgXcQ&key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    results.youtubeData = ytResponse.ok;
    if (results.youtubeData) {
      logger.info('Google Cloud key: YouTube Data API accessible');
    } else {
      logger.warn({ status: ytResponse.status }, 'Google Cloud key: YouTube Data API not accessible');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Google Cloud key: YouTube Data test failed');
  }

  return results;
}

/**
 * @deprecated Use validateGoogleCloudKey instead
 */
export async function validateGoogleAiKey(apiKey: string): Promise<boolean> {
  const result = await validateGoogleCloudKey(apiKey);
  return result.generativeAi;
}

/**
 * Validate an OpenAI API key by making a minimal API call.
 */
export async function validateOpenAiKey(apiKey: string): Promise<boolean> {
  const logger = getLogger();

  try {
    const client = new OpenAI({ apiKey });
    await client.chat.completions.create({
      model: 'gpt-5-nano',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    logger.info('OpenAI API key validated successfully');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'OpenAI API key validation failed');
    return false;
  }
}

/**
 * Validate an OpenAI-compatible API key by making a minimal API call.
 * Works with Mistral, DeepSeek, xAI, Groq, Together, OpenRouter, LiteLLM, etc.
 */
export async function validateOpenAiCompatibleKey(
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<boolean> {
  const logger = getLogger();

  try {
    const client = new OpenAI({ apiKey, baseURL: baseUrl });
    await client.chat.completions.create({
      model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    logger.info({ baseUrl }, 'OpenAI-compatible API key validated successfully');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg, baseUrl }, 'OpenAI-compatible API key validation failed');
    return false;
  }
}

/**
 * Validate an LLM API key based on the provider type.
 * Routes to the appropriate validation method.
 */
export async function validateLlmKey(
  providerId: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
): Promise<boolean> {
  const provider = getProvider(providerId);
  const clientType: ClientType = provider?.clientType ?? 'openai_compatible';

  switch (clientType) {
    case 'anthropic':
      return validateAnthropicKey(apiKey);

    case 'openai':
      return validateOpenAiKey(apiKey);

    case 'openai_compatible': {
      const resolvedBaseUrl = baseUrl ?? provider?.baseUrl;
      if (resolvedBaseUrl === undefined) {
        return false;
      }
      return validateOpenAiCompatibleKey(apiKey, resolvedBaseUrl, model);
    }
  }
}

/**
 * Store an encrypted secret for an instance.
 */
export function storeInstanceSecret(
  globalDb: SqliteDatabase,
  instanceId: string,
  keyType: string,
  plaintext: string,
): void {
  const config = getConfig();
  const encrypted = encrypt(plaintext, config.MASTER_ENCRYPTION_KEY);

  globalDb.prepare(`
    INSERT INTO instance_secrets (instance_id, key_type, encrypted_value, iv, auth_tag, validated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(instance_id, key_type)
    DO UPDATE SET encrypted_value = excluded.encrypted_value,
                  iv = excluded.iv,
                  auth_tag = excluded.auth_tag,
                  validated_at = excluded.validated_at,
                  updated_at = datetime('now')
  `).run(instanceId, keyType, encrypted.encrypted, encrypted.iv, encrypted.authTag);
}
