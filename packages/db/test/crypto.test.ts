import { describe, expect, it } from 'vitest';
import { decryptSecret, deriveEncryptionKey, encryptSecret } from '../src/crypto.js';

describe('token encryption', () => {
  const key = deriveEncryptionKey('a-very-long-application-secret-value-0123456789');
  it('round trips and is non-deterministic', () => {
    const a = encryptSecret('token-123', key);
    const b = encryptSecret('token-123', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('token-123');
  });
  it('rejects tampering and wrong keys', () => {
    const enc = encryptSecret('secret', key);
    const other = deriveEncryptionKey('another-secret-that-is-also-long-enough-xyz');
    expect(() => decryptSecret(enc, other)).toThrow();
    const parts = enc.split('.');
    parts[2] = parts[2]!.slice(0, -2) + 'AA';
    expect(() => decryptSecret(parts.join('.'), key)).toThrow();
  });
  it('accepts an explicit 32-byte key and rejects others', () => {
    const explicit = Buffer.alloc(32, 7).toString('base64');
    expect(deriveEncryptionKey('x'.repeat(40), explicit).length).toBe(32);
    expect(() => deriveEncryptionKey('x'.repeat(40), Buffer.alloc(16).toString('base64'))).toThrow();
  });
});
