import type { Env } from '@studio/config';
import { decryptSecret, deriveEncryptionKey, encryptSecret } from '@studio/db';

/**
 * Credentials for external services are stored encrypted (AES-256-GCM, packages/db/src/crypto.ts) and decrypted
 * only here, in the worker, just before a call. Plain values never go into job payloads, the audit log, logs or
 * anything the browser receives.
 */
export function credentialKey(env: Pick<Env, 'APP_SECRET' | 'APP_ENCRYPTION_KEY'>): Buffer {
  return deriveEncryptionKey(env.APP_SECRET, env.APP_ENCRYPTION_KEY ?? null);
}

/** Encrypts a credential for storage. */
export function encryptCredential(env: Pick<Env, 'APP_SECRET' | 'APP_ENCRYPTION_KEY'>, plain: string): string {
  return encryptSecret(plain, credentialKey(env));
}

/** Decrypts a stored credential; throws when the value was tampered with or the key changed. */
export function decryptCredential(env: Pick<Env, 'APP_SECRET' | 'APP_ENCRYPTION_KEY'>, stored: string): string {
  return decryptSecret(stored, credentialKey(env));
}

/** Decrypts a stored credential, or returns null when none is stored. */
export function decryptOptionalCredential(env: Pick<Env, 'APP_SECRET' | 'APP_ENCRYPTION_KEY'>, stored: string | null | undefined): string | null {
  return stored ? decryptCredential(env, stored) : null;
}
