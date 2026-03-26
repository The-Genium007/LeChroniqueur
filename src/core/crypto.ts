import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

export interface EncryptedData {
  readonly encrypted: string;
  readonly iv: string;
  readonly authTag: string;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * The masterKey must be a 64-char hex string (32 bytes).
 */
export function encrypt(plaintext: string, masterKey: string): EncryptedData {
  const key = Buffer.from(masterKey, 'hex');

  if (key.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

/**
 * Decrypt an EncryptedData object back to plaintext.
 * Throws if the data has been tampered with (GCM authentication failure).
 */
export function decrypt(data: EncryptedData, masterKey: string): string {
  const key = Buffer.from(masterKey, 'hex');

  if (key.length !== 32) {
    throw new Error('MASTER_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(data.iv, 'hex'),
    { authTagLength: AUTH_TAG_LENGTH },
  );
  decipher.setAuthTag(Buffer.from(data.authTag, 'hex'));

  let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
