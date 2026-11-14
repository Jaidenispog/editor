import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebsiteFetcher, followRedirects, type FetchPolicy } from '../src/website/fetcher.js';
import { BlockedHostError, isBlockedAddress, mappedIpv4, resolveSafeAddress } from '../src/website/ssrf.js';

describe('crawler SSRF guard', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    // IPv6 ranges that embed or translate IPv4 (a NAT64 gateway or tunnel could reach internal IPv4 through them).
    '::a00:1',
    '::10.0.0.1',
    '::ffff:0:a00:1',
    '0:0:0:0:0:ffff:a00:1',
    '64:ff9b::a00:1',
    '64:ff9b:1::a00:1',
    '100::1',
    '2001::a00:1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2002:a00:1::1',
    '2002:808:808::1',
    'fec0::1',
    'feff::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '142.250.70.164', '2606:4700:4700::1111', '2001:4860:4860::8888', '2400:cb00::1', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:808:808'])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('reads IPv4-mapped IPv6 in both forms', () => {
    expect(mappedIpv4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(mappedIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(mappedIpv4('2001:db8::1')).toBeNull();
  });

  it('refuses a host when ANY of its addresses is private, and allows loopback only for test policies', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ];
    await expect(resolveSafeAddress('mixed.example', { allowLoopback: false }, mixed)).rejects.toBeInstanceOf(BlockedHostError);
    const loop = async () => [{ address: '127.0.0.1', family: 4 }];
    await expect(resolveSafeAddress('local.example', { allowLoopback: false }, loop)).rejects.toThrow(/private or reserved/);
    await expect(resolveSafeAddress('local.example', { allowLoopback: true }, loop)).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    // Even a test policy never allows other private ranges.
    await expect(resolveSafeAddress('10.0.0.1', { allowLoopback: true })).rejects.toBeInstanceOf(BlockedHostError);
  });

  describe('against a local server', () => {
    let server: http.Server;
    let port = 0;
    const seen: string[] = [];
    beforeAll(async () => {
      server = http.createServer((req, res) => {
        seen.push(`${req.headers.host} ${req.url}`);
        if (req.url === '/to-private') {
          res.writeHead(302, {
            location: 'http://169.254.169.254/latest/meta-data/',
          });
          return res.end();
        }
        if (req.url === '/to-internal-name') {
          res.writeHead(302, { location: 'http://internal.example/admin' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p>ok</p>');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const policy = (resolver: FetchPolicy['resolver']): FetchPolicy => ({
      allowLoopback: true,
      testHttpPort: port,
      resolver,
      politeIntervalMs: 0,
    });

    it('refuses a redirect to a private address without sending anything there', async () => {
      let lookups = 0;
      const fetcher = new WebsiteFetcher(
        policy(async (h) => {
          lookups++;
          if (h === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
          if (h === 'internal.example') return [{ address: '192.168.0.10', family: 4 }];
          throw new Error('nx');
        }),
        ['site.test'],
      );
      const viaIp = await followRedirects(fetcher, 'http://site.test/to-private', { allowHop: () => true });
      expect(viaIp.final.blocked).toBe(true);
      expect(viaIp.final.status).toBeNull();
      const viaName = await followRedirects(fetcher, 'http://site.test/to-internal-name', { allowHop: () => true });
      expect(viaName.final.blocked).toBe(true);
      expect(seen.some((s) => s.includes('meta-data') || s.includes('/admin'))).toBe(false);
      expect(lookups).toBeGreaterThan(0);
    });

    it('connects to the address it checked (pinned DNS), resolving once per request', async () => {
      // "rebind.test" does not exist in real DNS: the request can only arrive if the checked address is the one used.
      const answers = [[{ address: '127.0.0.1', family: 4 }], [{ address: '10.0.0.1', family: 4 }]];
      let calls = 0;
      const fetcher = new WebsiteFetcher(
        policy(async () => answers[Math.min(calls++, 1)] ?? []),
        ['rebind.test'],
      );
      const first = await fetcher.request('http://rebind.test/page');
      expect(first.status).toBe(200);
      expect(calls).toBe(1);
      expect(seen).toContain(`rebind.test:${port} /page`);
      // A later answer pointing at a private address is refused before any connection.
      const second = await fetcher.request('http://rebind.test/page2');
      expect(second.blocked).toBe(true);
      expect(seen.some((s) => s.endsWith('/page2'))).toBe(false);
    });

    it('refuses other ports, other schemes and credentials in the address', async () => {
      const fetcher = new WebsiteFetcher(
        policy(async () => [{ address: '127.0.0.1', family: 4 }]),
        ['site.test'],
      );
      expect((await fetcher.request(`http://site.test:${port}/`)).blocked).toBe(true);
      expect((await fetcher.request('ftp://site.test/')).blocked).toBe(true);
      expect((await fetcher.request('http://user:pw@site.test/')).blocked).toBe(true);
    });

    it('spaces requests to the owner’s site and honours Crawl-delay', async () => {
      let clock = 0;
      const waits: number[] = [];
      const fetcher = new WebsiteFetcher(
        {
          ...policy(async () => [{ address: '127.0.0.1', family: 4 }]),
          politeIntervalMs: 500,
        },
        ['site.test'],
        () => clock,
        async (ms) => {
          waits.push(ms);
          clock += ms;
        },
      );
      fetcher.setCrawlDelay(1);
      await fetcher.request('http://site.test/a');
      await fetcher.request('http://site.test/b');
      await fetcher.request('http://site.test/c');
      expect(waits).toEqual([1000, 1000]);
      expect(fetcher.requestCount).toBe(3);
    });
  });
});
