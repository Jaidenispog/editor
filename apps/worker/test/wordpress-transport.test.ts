/**
 * The SSRF-guarded WordPress transport (design §7.1, §7.4.2): addresses are checked and pinned like the crawler's,
 * redirects are never followed, and the adapter refuses a redirecting REST API. A local HTTP server stands in for a
 * WordPress site through the test-only policy (loopback allowed, fixture port); nothing on the internet is contacted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WP_MESSAGES, WordPressAdapter, AdapterRedirectError } from '../src/website/adapters/wordpress.js';
import type { FetchPolicy } from '../src/website/fetcher.js';
import { createGuardedFetch } from '../src/website/guarded-fetch.js';
import { BlockedHostError } from '../src/website/ssrf.js';

const signal = new AbortController().signal;

describe('guarded WordPress transport', () => {
  let server: http.Server;
  let port = 0;
  const seen: Array<{ method: string; url: string }> = [];
  let policy: FetchPolicy;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.url === '/wp-json/') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      }
      if (req.url?.startsWith('/wp-json/wp/v2/pages/12')) {
        res.writeHead(308, { location: 'http://10.0.0.5/steal' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, method: req.method }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    policy = { allowLoopback: true, testHttpPort: port, resolver: async () => [{ address: '127.0.0.1', family: 4 }] };
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses hosts that resolve to private, link-local or metadata addresses, before connecting', async () => {
    for (const address of ['10.0.0.5', '169.254.169.254', '192.168.1.10', '::ffff:127.0.0.1']) {
      const f = createGuardedFetch({ allowLoopback: false, resolver: async () => [{ address, family: address.includes(':') ? 6 : 4 }] });
      await expect(f('https://wp.example.com.au/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
    }
    // A host with one public and one private address is refused too (no "pick the good one").
    const mixed = createGuardedFetch({
      allowLoopback: false,
      resolver: async () => [
        { address: '203.2.218.10', family: 4 },
        { address: '10.1.1.1', family: 4 },
      ],
    });
    await expect(mixed('https://wp.example.com.au/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('only speaks https on 443 (plain http only on the test policy’s fixture port) and never sends credentials in the address', async () => {
    const f = createGuardedFetch({ allowLoopback: false, resolver: async () => [{ address: '203.2.218.10', family: 4 }] });
    await expect(f('http://wp.example.com.au/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
    await expect(f('https://wp.example.com.au:8443/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
    await expect(f('https://user:pass@wp.example.com.au/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('returns a redirect as it is and never follows it', async () => {
    seen.length = 0;
    const f = createGuardedFetch(policy);
    const res = await f('http://wp.example.com.au/wp-json/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://169.254.169.254/latest/meta-data/');
    expect(seen).toEqual([{ method: 'GET', url: '/wp-json/' }]);
    const ok = await f('http://wp.example.com.au/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"content":"x"}' });
    expect(await ok.json()).toEqual({ ok: true, method: 'POST' });
  });

  it('the adapter treats a redirecting REST API as a problem: the check says so and a write is refused, never re-sent', async () => {
    const adapter = new WordPressAdapter(
      { logger: pino({ level: 'silent' }), fetch: createGuardedFetch(policy) },
      { baseUrl: 'http://wp.example.com.au', username: 'studio-assistant', applicationPassword: 'abcd efgh ijkl mnop', publicWebsite: 'https://www.example.com.au/' },
    );
    seen.length = 0;
    expect(await adapter.check(signal)).toMatchObject({ ok: false, problem: WP_MESSAGES.redirected });
    await expect(adapter.write({ resourceType: 'page', resourceId: '12', link: 'http://wp.example.com.au/contact/', current: 'a', modifiedGmt: null }, 'b', signal)).rejects.toBeInstanceOf(AdapterRedirectError);
    // Only the two requests to the WordPress host itself; the redirect targets were never contacted.
    expect(seen.map((s) => s.url)).toEqual(['/wp-json/', '/wp-json/wp/v2/pages/12']);
  });
});
