import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

/**
 * Derives the 32-byte key used to encrypt integration tokens at rest.
 * APP_ENCRYPTION_KEY (base64, 32 bytes) wins; otherwise the key is derived from APP_SECRET with HKDF so a
 * single secret is enough for small deployments while still allowing key separation later.
 */
export function deriveEncryptionKey(appSecret: string, explicitKeyBase64?: string | null): Buffer {
  if (explicitKeyBase64) {
    const key = Buffer.from(explicitKeyBase64, 'base64');
    if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must decode to exactly 32 bytes');
    return key;
  }
  return Buffer.from(hkdfSync('sha256', appSecret, 'studio-assistant', 'token-encryption-v1', 32));
}

/** Encrypts UTF-8 text → "v1.<iv>.<ciphertext>.<tag>" (all base64url). */
export function encryptSecret(plainText: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), enc.toString('base64url'), tag.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, encB64, tagB64] = payload.split('.');
  if (version !== VERSION || !ivB64 || !encB64 || !tagB64) throw new Error('Unrecognised encrypted payload');
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64url')), decipher.final()]).toString('utf8');
}
