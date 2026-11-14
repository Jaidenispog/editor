import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppSettingsSchema, settingsSnapshot, siteScopeFrom } from '@studio/core';
import { MAX_POLITE_WAIT_SECONDS, crawlSite } from '../src/website/crawl.js';
import { WebsiteFetcher, type FetchPolicy } from '../src/website/fetcher.js';

/**
 * The crawl's polite-wait budget and robots.txt rules against a tiny local site (no database, no internet): a very
 * long Crawl-delay ends as a partial check (never a thrown error), a redirect to a disallowed address is never
 * followed, and pages on the www./bare twin host follow that host's own robots.txt.
 */

const HOST = 'crawl-site.test';
const TWIN = `www.${HOST}`;
/** A robots.txt value that makes the test site answer 503 for it. */
const SERVER_ERROR = '<503>';
const page = (body: string) => `<!doctype html><html lang="en-AU"><head><title>Ivanhoe Barber Co</title></head><body>${body}</body></html>`;

describe('website crawl: budget and robots.txt per host and per hop', () => {
  let server: http.Server;
  let port = 0;
  const seen: string[] = [];
  /** robots.txt per host (tests set it). */
  const robots: Record<string, string> = {};
  let homeBody = '';
  /** The twin host does not resolve (a network error for anything on it). */
  let twinDown = false;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const host = (req.headers.host ?? '').split(':')[0] ?? '';
      const path = req.url ?? '/';
      seen.push(`${req.method} ${host}${path}`);
      const send = (status: number, body: string, type = 'text/html', headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': type, ...headers });
        res.end(req.method === 'HEAD' ? undefined : body);
      };
      if (path === '/robots.txt') {
        if (robots[host] === SERVER_ERROR) return send(503, 'down', 'text/plain');
        return robots[host] !== undefined ? send(200, robots[host], 'text/plain') : send(404, 'not found', 'text/plain');
      }
      if (host === HOST && path === '/') return homeBody.startsWith('REDIRECT ') ? send(301, '', 'text/html', { location: homeBody.slice(9) }) : send(200, page(homeBody));
      if (path === '/old-prices') return send(301, '', 'text/html', { location: '/private/prices' });
      if (path.startsWith('/private/') || path.startsWith('/members/')) return send(200, page('<p>secret</p>'));
      if (path === '/about/' || path === '/contact/') return send(200, page('<h1>About</h1><p>Fades in Ivanhoe.</p>'));
      return send(404, page('<p>Not found</p>'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
    for (const k of Object.keys(robots)) delete robots[k];
    homeBody = '<h1>Ivanhoe Barber Co</h1><p>Fades and beard trims.</p>';
    twinDown = false;
  });

  const settings = AppSettingsSchema.parse({
    brand: { businessName: 'Ivanhoe Barber Co' },
    business: { website: `http://${HOST}/`, phone: '03 9499 1234', suburb: 'Ivanhoe', postcode: '3079' },
  });
  const scope = siteScopeFrom(settings.business.website)!;

  async function crawl() {
    let clock = 0;
    const slept: number[] = [];
    const policy: FetchPolicy = {
      allowLoopback: true,
      testHttpPort: port,
      politeIntervalMs: 0,
      resolver: async (h) => {
        if (h === HOST || (h === TWIN && !twinDown)) return [{ address: '127.0.0.1', family: 4 }];
        throw new Error('ENOTFOUND');
      },
    };
    const fetcher = new WebsiteFetcher(policy, [scope.host, scope.twinHost], () => clock, async (ms) => {
      slept.push(ms);
      clock += ms;
    });
    const out = await crawlSite({
      scope,
      snapshot: settingsSnapshot(settings),
      checkExternalLinks: false,
      watchTexts: new Map(),
      fetcher,
      signal: new AbortController().signal,
      progress: async () => {},
      checkCancelled: () => {},
    });
    return { out, waited: slept.reduce((a, b) => a + b, 0) };
  }

  it.each([300, 600])('Crawl-delay %i ends as a partial check that still reads the home page (never a thrown budget error)', async (delay) => {
    robots[HOST] = `User-agent: *\nCrawl-delay: ${delay}\n`;
    robots[TWIN] = robots[HOST];
    const { out, waited } = await crawl();
    expect(waited).toBeLessThanOrEqual(MAX_POLITE_WAIT_SECONDS * 1000);
    const home = out.facts.pages[0];
    expect(home).toMatchObject({ status: 200, skipped: null, error: null });
    expect(out.homeNotRead).toBe(false);
    expect(out.partialReasons.join(' ')).toMatch(/Crawl-delay/);
    // The optional host-variant requests were skipped to keep the home page's budget.
    expect(out.facts.hostVariants.length).toBeLessThan(4);
    expect(seen).toContain(`GET ${HOST}/`);
  });

  it('never follows a redirect to an address robots.txt disallows, and records the page as skipped for robots', async () => {
    robots[HOST] = 'User-agent: *\nDisallow: /private/\n';
    robots[TWIN] = robots[HOST];
    homeBody = '<h1>Ivanhoe Barber Co</h1><a href="/old-prices">Prices</a><a href="/about/">About</a>';
    const { out } = await crawl();
    expect(seen).toContain(`GET ${HOST}/old-prices`);
    expect(seen.some((s) => s.includes('/private/'))).toBe(false);
    expect(out.facts.pages.find((p) => p.url.endsWith('/old-prices'))).toMatchObject({ skipped: 'robots' });
    expect(out.facts.robots.blockedForUs).toContain(`http://${HOST}/private/prices`);
    expect(out.facts.pages.find((p) => p.url.endsWith('/about/'))).toMatchObject({ status: 200, skipped: null });
  });

  it('reads pages on the www. twin only as that host’s own robots.txt allows', async () => {
    robots[HOST] = 'User-agent: *\nDisallow:\n';
    robots[TWIN] = 'User-agent: *\nDisallow: /members/\n';
    homeBody = `<h1>Ivanhoe Barber Co</h1><a href="http://${TWIN}/members/">Members</a><a href="http://${TWIN}/about/">About</a>`;
    const { out } = await crawl();
    expect(seen.filter((s) => s === `GET ${TWIN}/robots.txt`)).toHaveLength(1);
    expect(seen.some((s) => s.startsWith(`GET ${TWIN}/members/`))).toBe(false);
    expect(seen).toContain(`GET ${TWIN}/about/`);
    expect(out.facts.robots.blockedForUs).toContain(`http://${TWIN}/members/`);
  });

  it('a home page that forwards to a disallowed address is a partial check without findings, not "site unreachable"', async () => {
    robots[HOST] = 'User-agent: *\nDisallow: /private/\n';
    homeBody = 'REDIRECT /private/home';
    const { out } = await crawl();
    expect(out.homeNotRead).toBe(true);
    expect(out.partialReasons.join(' ')).toMatch(/forwards to an address your robots\.txt/);
    expect(out.facts.pages[0]).toMatchObject({ skipped: 'robots' });
    expect(seen.some((s) => s.includes('/private/'))).toBe(false);
  });

  describe('a home page that forwards to the twin host gives the reason that matches the twin robots.txt', () => {
    const forwardsToTwin = () => {
      homeBody = `REDIRECT http://${TWIN}/`;
    };
    it('the twin robots.txt was read and disallows everything', async () => {
      robots[HOST] = 'User-agent: *\nDisallow:\n';
      robots[TWIN] = 'User-agent: *\nDisallow: /\n';
      forwardsToTwin();
      const { out } = await crawl();
      expect(out.homeNotRead).toBe(true);
      expect(out.partialReasons).toContain("Your home page forwards to an address your robots.txt asks automated tools not to read, so we didn't check your pages.");
      expect(seen).not.toContain(`GET ${TWIN}/`);
    });
    it('the twin robots.txt gave a server error', async () => {
      robots[HOST] = 'User-agent: *\nDisallow:\n';
      robots[TWIN] = SERVER_ERROR;
      forwardsToTwin();
      const { out } = await crawl();
      expect(out.homeNotRead).toBe(true);
      const reason = out.partialReasons.join(' ');
      expect(reason).toContain(`forwards to ${TWIN}, whose robots.txt couldn't be read`);
      expect(reason).not.toMatch(/asks automated tools not to read/);
      expect(seen).not.toContain(`GET ${TWIN}/`);
    });
    it('the twin host gave no answer at all', async () => {
      robots[HOST] = 'User-agent: *\nDisallow:\n';
      twinDown = true;
      forwardsToTwin();
      const { out } = await crawl();
      expect(out.homeNotRead).toBe(true);
      const reason = out.partialReasons.join(' ');
      expect(reason).toContain(`forwards to ${TWIN}, whose robots.txt couldn't be read`);
      expect(reason).not.toMatch(/asks automated tools not to read/);
    });
    it('the twin robots.txt was skipped to keep the polite-wait budget for the home page', async () => {
      robots[HOST] = 'User-agent: *\nCrawl-delay: 600\n';
      robots[TWIN] = 'User-agent: *\nDisallow:\n';
      forwardsToTwin();
      const { out } = await crawl();
      expect(seen).not.toContain(`GET ${TWIN}/robots.txt`);
      expect(out.homeNotRead).toBe(true);
      const reason = out.partialReasons.join(' ');
      expect(reason).toContain(`forwards to ${TWIN}. Your robots.txt asks for a very slow crawl (Crawl-delay)`);
      expect(reason).not.toMatch(/asks automated tools not to read/);
    });
  });
});
