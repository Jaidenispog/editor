import { randomBytes } from 'node:crypto';
import { deriveEncryptionKey } from '@studio/db';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/lib/crypto';

describe('token encryption (AES-256-GCM)', () => {
  const key = deriveEncryptionKey('test-secret-that-is-at-least-thirty-two-chars');

  it('round-trips text and uses a fresh IV each time', () => {
    const a = encryptToken('EAAB-access-token-✓', key);
    const b = encryptToken('EAAB-access-token-✓', key);
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('EAAB');
    expect(decryptToken(a, key)).toBe('EAAB-access-token-✓');
    expect(decryptToken(b, key)).toBe('EAAB-access-token-✓');
  });

  it('refuses tampered ciphertext', () => {
    const payload = encryptToken('refresh-token', key);
    const parts = payload.split('.');
    const ct = Buffer.from(parts[2] ?? '', 'base64url');
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[2] = ct.toString('base64url');
    expect(() => decryptToken(parts.join('.'), key)).toThrow();
  });

  it('refuses the wrong key', () => {
    const payload = encryptToken('secret', key);
    expect(() => decryptToken(payload, deriveEncryptionKey('another-secret-that-is-at-least-thirty-two'))).toThrow();
  });

  it('prefers an explicit 32-byte APP_ENCRYPTION_KEY and rejects other lengths', () => {
    const explicit = randomBytes(32).toString('base64');
    const k = deriveEncryptionKey('ignored-secret-ignored-secret-ignored', explicit);
    expect(k.equals(Buffer.from(explicit, 'base64'))).toBe(true);
    expect(decryptToken(encryptToken('x', k), k)).toBe('x');
    expect(() => deriveEncryptionKey('s'.repeat(40), randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
