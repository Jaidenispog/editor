import { describe, expect, it } from 'vitest';
import { isBlockedAddress, privateHostReason } from '../src/address-ranges.js';

describe('address ranges (SSRF guard shared by the worker and the web app)', () => {
  it('blocks private, loopback, link-local, metadata and mapped forms; allows public addresses', () => {
    for (const a of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.0.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:a00:1']) expect(isBlockedAddress(a), a).toBe(true);
    for (const a of ['203.2.218.10', '1.1.1.1', '2606:4700:4700::1111']) expect(isBlockedAddress(a), a).toBe(false);
  });

  it('names why an owner-typed host can never be a public website', () => {
    expect(privateHostReason('10.0.0.5')).toMatch(/private/);
    expect(privateHostReason('[::1]')).toMatch(/private/);
    expect(privateHostReason('localhost')).toMatch(/localhost/);
    expect(privateHostReason('wp.localhost')).toMatch(/localhost/);
    expect(privateHostReason('wordpress')).toMatch(/local network/);
    expect(privateHostReason('nas.local')).toMatch(/local network/);
    expect(privateHostReason('www.ivanhoebarber.com.au')).toBeNull();
    expect(privateHostReason('203.2.218.10')).toBeNull();
  });
});
