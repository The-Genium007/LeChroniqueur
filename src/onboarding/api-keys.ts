import Anthropic from '@anthropic-ai/sdk';
import { encrypt } from '../core/crypto.js';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';

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
 * Validate a Google AI API key by listing models.
 */
export async function validateGoogleAiKey(apiKey: string): Promise<boolean> {
  const logger = getLogger();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const valid = response.ok;
    if (valid) {
      logger.info('Google AI API key validated successfully');
    } else {
      logger.warn({ status: response.status }, 'Google AI API key validation failed');
    }
    return valid;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Google AI API key validation failed');
    return false;
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
