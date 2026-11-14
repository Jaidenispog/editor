import 'server-only';
import { decryptSecret, deriveEncryptionKey, encryptSecret } from '@studio/db';
import { getEnv } from './env.js';

/**
 * AES-256-GCM encryption for integration tokens at rest. The key is APP_ENCRYPTION_KEY (base64, 32 bytes) or,
 * when that is unset, an HKDF derivation of APP_SECRET. The cipher itself lives in @studio/db so the worker and
 * the web app always produce compatible payloads.
 */
export function getEncryptionKey(): Buffer {
  const env = getEnv();
  return deriveEncryptionKey(env.APP_SECRET, env.APP_ENCRYPTION_KEY ?? null);
}

/** Encrypts a token for storage ("v1.<iv>.<ciphertext>.<tag>"). */
export function encryptToken(plainText: string, key: Buffer = getEncryptionKey()): string {
  return encryptSecret(plainText, key);
}

/** Decrypts a stored token; throws when the payload was tampered with or the key changed. */
export function decryptToken(payload: string, key: Buffer = getEncryptionKey()): string {
  return decryptSecret(payload, key);
}
