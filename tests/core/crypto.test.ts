import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, type EncryptedData } from '../../src/core/crypto.js';
import { randomBytes } from 'node:crypto';

const MASTER_KEY = randomBytes(32).toString('hex');

describe('crypto', () => {
  it('should encrypt and decrypt a string', () => {
    const plaintext = 'sk-ant-api03-my-secret-key';
    const encrypted = encrypt(plaintext, MASTER_KEY);
    const decrypted = decrypt(encrypted, MASTER_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertext for the same input (random IV)', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext, MASTER_KEY);
    const b = encrypt(plaintext, MASTER_KEY);
    expect(a.encrypted).not.toBe(b.encrypted);
    expect(a.iv).not.toBe(b.iv);
  });

  it('should fail to decrypt with wrong key', () => {
    const plaintext = 'secret';
    const encrypted = encrypt(plaintext, MASTER_KEY);
    const wrongKey = randomBytes(32).toString('hex');
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it('should fail to decrypt tampered data', () => {
    const encrypted = encrypt('test', MASTER_KEY);
    const tampered: EncryptedData = {
      ...encrypted,
      encrypted: encrypted.encrypted.slice(0, -2) + 'ff',
    };
    expect(() => decrypt(tampered, MASTER_KEY)).toThrow();
  });

  it('should reject invalid key length', () => {
    expect(() => encrypt('test', 'too-short')).toThrow('64-character hex');
  });

  it('should handle empty string', () => {
    const encrypted = encrypt('', MASTER_KEY);
    const decrypted = decrypt(encrypted, MASTER_KEY);
    expect(decrypted).toBe('');
  });

  it('should handle unicode content', () => {
    const plaintext = 'clé API avec des accents: éàü 🎲';
    const encrypted = encrypt(plaintext, MASTER_KEY);
    const decrypted = decrypt(encrypted, MASTER_KEY);
    expect(decrypted).toBe(plaintext);
  });
});
