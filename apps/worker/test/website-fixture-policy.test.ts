import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { websiteFetchPolicy } from '../src/website/deps.js';
import { DEFAULT_FETCH_POLICY, WebsiteFetcher } from '../src/website/fetcher.js';
import { createGuardedFetch } from '../src/website/guarded-fetch.js';
import { BlockedHostError, resolveSafeAddress } from '../src/website/ssrf.js';

/**
 * WEBSITE_FIXTURE_BASE_URL (Stage C website browser test): under NODE_ENV=test it lets the website check and the
 * WordPress transport reach one exact fixture host name on 127.0.0.1; in any other environment it does nothing, and
 * even under test every other loopback or private address stays refused.
 */
describe('test-only fixture website policy', () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.headers.host} ${req.url}`);
      res.writeHead(200, { 'content-type': req.url?.startsWith('/wp-json') ? 'application/json' : 'text/html' });
      res.end(req.url?.startsWith('/wp-json') ? '{"namespaces":["wp/v2"]}' : '<p>fixture</p>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
  });

  const env = (NODE_ENV: 'test' | 'production' | 'development') => ({ NODE_ENV, WEBSITE_FIXTURE_BASE_URL: `http://ivanhoe-studio.test:${port}` });

  it('is inert outside NODE_ENV=test: production and development keep the strict default policy', () => {
    expect(websiteFetchPolicy(env('production'))).toBe(DEFAULT_FETCH_POLICY);
    expect(websiteFetchPolicy(env('development'))).toBe(DEFAULT_FETCH_POLICY);
    expect(websiteFetchPolicy({ NODE_ENV: 'test', WEBSITE_FIXTURE_BASE_URL: undefined })).toBe(DEFAULT_FETCH_POLICY);
    expect(DEFAULT_FETCH_POLICY).toEqual({ allowLoopback: false });
    expect(websiteFetchPolicy(env('test'))).toEqual({ allowLoopback: false, fixture: { host: 'ivanhoe-studio.test', port } });
  });

  it('in production the fixture name is refused even when it resolves to the local server, and nothing is sent', async () => {
    const policy = { ...websiteFetchPolicy(env('production')), politeIntervalMs: 0, resolver: async () => [{ address: '127.0.0.1', family: 4 }] };
    const fetcher = new WebsiteFetcher(policy, ['ivanhoe-studio.test']);
    const res = await fetcher.request('http://ivanhoe-studio.test/');
    expect(res.blocked).toBe(true);
    expect(res.status).toBeNull();
    await expect(createGuardedFetch(policy)('http://ivanhoe-studio.test/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
    await expect(createGuardedFetch(policy)('https://ivanhoe-studio.test/wp-json/')).rejects.toBeInstanceOf(BlockedHostError);
    expect(seen).toEqual([]);
  });

  it('under NODE_ENV=test only the exact fixture host reaches the local server', async () => {
    const policy = { ...websiteFetchPolicy(env('test')), politeIntervalMs: 0 };
    const fetcher = new WebsiteFetcher(policy, ['ivanhoe-studio.test']);
    const ok = await fetcher.request('http://IVANHOE-STUDIO.test/contact/');
    expect(ok.status).toBe(200);
    expect(seen).toEqual([`GET ivanhoe-studio.test:${port} /contact/`]);
    const wp = await createGuardedFetch(policy)('http://ivanhoe-studio.test/wp-json/');
    expect(wp.status).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('under NODE_ENV=test every other loopback, private or look-alike address is still refused before connecting', async () => {
    const policy = { ...websiteFetchPolicy(env('test')), politeIntervalMs: 0 };
    const fetcher = new WebsiteFetcher(policy, ['ivanhoe-studio.test']);
    for (const url of [
      'http://127.0.0.1/',
      `http://127.0.0.1:${port}/`,
      'http://[::1]/',
      'http://10.0.0.5/',
      'http://192.168.1.10/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost/',
      'http://www.ivanhoe-studio.test/',
      'http://ivanhoe-studio.test.evil.example/',
      `http://ivanhoe-studio.test:${port}/`,
    ]) {
      const res = await fetcher.request(url);
      expect(res.status, url).toBeNull();
      expect(res.error, url).not.toBeNull();
    }
    await expect(resolveSafeAddress('127.0.0.1', policy)).rejects.toThrow(/private or reserved/);
    await expect(resolveSafeAddress('10.0.0.5', policy)).rejects.toBeInstanceOf(BlockedHostError);
    await expect(resolveSafeAddress('other.test', policy, async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow(/private or reserved/);
    for (const url of ['http://127.0.0.1/wp-json/', 'http://localhost/wp-json/', 'http://10.0.0.5/wp-json/', `http://ivanhoe-studio.test:${port}/wp-json/`]) {
      await expect(createGuardedFetch(policy)(url), url).rejects.toBeInstanceOf(BlockedHostError);
    }
    expect(seen).toEqual([]);
  });
});
