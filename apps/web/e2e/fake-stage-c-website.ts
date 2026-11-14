/**
 * Local fakes for the Stage C website browser test (apps/web/e2e/stage-c-website.e2e.mjs), run as their own process.
 * Nothing here talks to a real website, WordPress or Google.
 *
 * 1. The website, on FAKE_SITE_PORT (127.0.0.1): the worker's fixture site (apps/worker/test/helpers/fixture-site.ts,
 *    with its known issues: robots.txt disallowing /private/, Crawl-delay: 1, a gzip sitemap behind an index, a 404 and
 *    a redirect in the sitemap, noindex, a redirect chain, a soft 404, duplicate titles, invalid JSON-LD, a wrong
 *    phone number, a large image without dimensions, a broken link and 30 extra pages) behind a small front server that
 *    also answers the WordPress REST API (`/wp-json/…`, the in-memory fake from apps/worker/test/fakes/wordpress.ts)
 *    for the same host, and shows the WordPress text of the home and contact pages on the public pages, the way a real
 *    WordPress site would. The web app and worker reach it as http://ivanhoe-studio.test/ through the test-only
 *    WEBSITE_FIXTURE_BASE_URL (honoured only when NODE_ENV=test).
 * 2. Google, on FAKE_GOOGLE_PORT: one server standing in for every Google host the app calls, addressed as
 *    `/<google host>/<path>` (GOOGLE_API_BASE_URL, honoured only when NODE_ENV=test): the OAuth consent screen (approves
 *    at once and redirects back with a code, checking PKCE), the token endpoint, Search Console (`sites`,
 *    `searchAnalytics.query` with a fixed data set) and the Business Profile APIs (the in-memory fake from
 *    apps/worker/test/fakes/google-business-profile.ts: accounts, locations, reviews and Performance, with quota 0
 *    switchable).
 *
 *   FAKE_SITE_PORT=4701 FAKE_GOOGLE_PORT=4702 FAKE_WP_PASSWORD='abcd efgh ijkl mnop' tsx apps/web/e2e/fake-stage-c-website.ts
 *
 * Control (on the Google port): `GET /__fake/state` (requests, writes, calls and the data sets), `POST /__fake/wordpress/
 * edit-on-next-read` `{ id, raw }` (someone edits that page in WordPress just before the worker's next single-page
 * read), `POST /__fake/business-profile` `{ quotaZero }`. Prints one JSON line once both ports accept connections;
 * stops on SIGTERM or SIGINT.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FIXTURE_HOST, startFixtureSite } from '../../worker/test/helpers/fixture-site.js';
import { fakeBusinessProfile, type FakeReview } from '../../worker/test/fakes/google-business-profile.js';
import { fakeWordPress } from '../../worker/test/fakes/wordpress.js';
import { GOOGLE_TOKEN_URL } from '../../worker/src/lib/google/oauth.js';

const SITE_PORT = Number(process.env['FAKE_SITE_PORT'] ?? '0');
const GOOGLE_PORT = Number(process.env['FAKE_GOOGLE_PORT'] ?? '0');
const WP_USER = process.env['FAKE_WP_USER'] ?? 'studio-assistant';
const WP_PASSWORD = process.env['FAKE_WP_PASSWORD'] ?? 'abcd efgh ijkl mnop';
const CLIENT_ID = process.env['FAKE_GOOGLE_CLIENT_ID'] ?? 'e2e-client.apps.googleusercontent.com';
const CLIENT_SECRET = process.env['FAKE_GOOGLE_CLIENT_SECRET'] ?? 'e2e-client-secret';
for (const p of [SITE_PORT, GOOGLE_PORT]) {
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    console.error('FAKE_SITE_PORT and FAKE_GOOGLE_PORT must be port numbers.');
    process.exit(2);
  }
}

const SITE = `http://${FIXTURE_HOST}`;
const SCOPES = {
  business_profile: 'https://www.googleapis.com/auth/business.manage',
  search_console: 'https://www.googleapis.com/auth/webmasters.readonly',
} as const;

// ---- The website and WordPress --------------------------------------------------------------------------------
const fixture = await startFixtureSite();
/** The WordPress text of two public pages, exactly as the fixture site's HTML contains it. */
const CONTACT_RAW = '<h1>Contact</h1><p>Find us in Ivanhoe. Phone (03) 9876 5432.</p>';
const HOME_RAW = '<p>Fades, tapers and beard trims in Ivanhoe. Call (03) 9876 5432 to book.</p>';
const wp = fakeWordPress({
  base: SITE,
  username: WP_USER,
  password: WP_PASSWORD,
  items: [
    { id: 2, type: 'pages', slug: 'home', link: `${SITE}/`, raw: HOME_RAW },
    { id: 12, type: 'pages', slug: 'contact', link: `${SITE}/contact/`, raw: CONTACT_RAW },
  ],
});
const ORIGINAL_RAW = new Map(wp.state.items.map((i) => [i.id, i.raw]));
/** Every request the website (fixture pages and WordPress) received, in order. */
const siteRequests: Array<{ method: string; host: string; path: string; at: string }> = [];

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Forwards one request to the fixture site unchanged (same method, path and Host) and returns its answer. */
function fromFixture(req: http.IncomingMessage, body: Buffer): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const out = http.request(
      { host: '127.0.0.1', port: fixture.port, method: req.method, path: req.url, headers: req.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    out.on('error', reject);
    out.end(body.length ? body : undefined);
  });
}

const siteServer = http.createServer((req, res) => {
  void (async () => {
    const host = (req.headers.host ?? '').split(':')[0]?.toLowerCase() ?? '';
    const url = new URL(req.url ?? '/', `http://${host || FIXTURE_HOST}`);
    siteRequests.push({ method: req.method ?? 'GET', host, path: url.pathname, at: new Date().toISOString() });
    const body = await readBody(req);
    if (host === FIXTURE_HOST && url.pathname.startsWith('/wp-json')) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const answer = await wp.fetch(`${SITE}${url.pathname}${url.search}`, { method: req.method ?? 'GET', headers, ...(body.length ? { body: body.toString('utf8') } : {}) });
      const text = Buffer.from(await answer.arrayBuffer());
      res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json', 'content-length': String(text.length) });
      res.end(text);
      return;
    }
    const answer = await fromFixture(req, body);
    let out = answer.body;
    // The public home and contact pages show what WordPress holds for them now.
    const item = host === FIXTURE_HOST && (req.method === 'GET' || req.method === 'HEAD') ? wp.state.items.find((i) => new URL(i.link).pathname === url.pathname) : undefined;
    if (item && answer.status === 200 && req.method === 'GET') {
      const before = ORIGINAL_RAW.get(item.id) ?? '';
      out = Buffer.from(answer.body.toString('utf8').replace(before, item.raw), 'utf8');
    }
    const headers = { ...answer.headers, 'content-length': String(out.length) };
    delete headers['transfer-encoding'];
    res.writeHead(answer.status, headers);
    res.end(req.method === 'HEAD' ? undefined : out);
  })().catch((err: unknown) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`fake site error: ${err instanceof Error ? err.message : String(err)}`);
  });
});

// ---- Google ------------------------------------------------------------------------------------------------------
const bp = fakeBusinessProfile();
bp.state.quotaZero = true; // Google has not approved API access yet: the first answers are quota 0 (429).
bp.state.pageSize = 2;
const reviews: FakeReview[] = [
  { reviewId: 'r-1', starRating: 'FIVE', displayName: 'Mia Tran', comment: 'Best skin fade in Ivanhoe. Booked again for next month.', createTime: '2026-11-02T03:15:00Z', updateTime: '2026-11-02T03:15:00Z' },
  { reviewId: 'r-2', starRating: 'FOUR', displayName: 'Josh Kelly', comment: 'Quick beard trim, friendly chat. Parking was tricky.', createTime: '2026-10-21T06:40:00Z', updateTime: '2026-10-21T06:40:00Z', reply: 'Thanks Josh, see you next time!' },
  { reviewId: 'r-3', starRating: 'THREE', displayName: 'Sam Patel', comment: 'Good cut but I waited 20 minutes past my booking.', createTime: '2026-09-30T23:05:00Z', updateTime: '2026-09-30T23:05:00Z' },
];
bp.state.reviews = reviews;

/** A date `days` before today in Melbourne, as YYYY-MM-DD. */
function melbourneDaysAgo(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function pacificDaysAgo(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// Business Profile Performance: seven days ending five days ago. Calls, directions, website clicks and views are
// reported; BUSINESS_BOOKINGS is listed without any value and MESSAGING_CLICKS not at all (both must show as missing).
const perfDays = Array.from({ length: 7 }, (_, i) => melbourneDaysAgo(11 - i));
const perfSeries: Record<string, number[]> = {
  CALL_CLICKS: [2, 0, 3, 1, 4, 2, 1],
  BUSINESS_DIRECTION_REQUESTS: [5, 4, 6, 3, 7, 5, 4],
  WEBSITE_CLICKS: [3, 2, 4, 1, 5, 3, 2],
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: [40, 38, 45, 36, 50, 42, 39],
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: [10, 9, 12, 8, 11, 10, 9],
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: [25, 22, 27, 20, 30, 24, 23],
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: [5, 4, 6, 3, 7, 5, 4],
};
for (const [metric, values] of Object.entries(perfSeries)) bp.state.daily[metric] = Object.fromEntries(perfDays.map((d, i) => [d, values[i]]));
bp.state.daily['BUSINESS_BOOKINGS'] = Object.fromEntries(perfDays.map((d) => [d, undefined]));
bp.state.keywords = [
  { searchKeyword: 'barber ivanhoe', insightsValue: { value: '42' } },
  { searchKeyword: 'skin fade', insightsValue: { threshold: '15' } },
];

// Search Console: ten days ending three days ago (Google reports a few days late), three listed searches a day plus
// searches Google does not list individually.
const scDays = Array.from({ length: 10 }, (_, i) => pacificDaysAgo(12 - i));
const scQueries = scDays.flatMap((date, i) => [
  { date, query: 'barber ivanhoe', clicks: 2 + (i % 3), impressions: 30 + i, position: 4.5 },
  { date, query: 'ivanhoe barber co', clicks: 4, impressions: 12, position: 1.2 },
  { date, query: 'skin fade', clicks: 1, impressions: 25 + 2 * i, position: 9.8 },
]);
const scTotals = scDays.map((date) => {
  const day = scQueries.filter((q) => q.date === date);
  return { date, clicks: day.reduce((s, q) => s + q.clicks, 0) + 1, impressions: day.reduce((s, q) => s + q.impressions, 0) + 7, position: 6.3 };
});
const SC_PROPERTIES = [
  { siteUrl: `${SITE}/`, permissionLevel: 'siteOwner' },
  { siteUrl: `https://www.${FIXTURE_HOST}/`, permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://unrelated.example/', permissionLevel: 'siteUnverifiedUser' },
];

type Product = keyof typeof SCOPES;
const codes = new Map<string, { product: Product; challenge: string; redirectUri: string }>();
const scTokens = new Set<string>();
const google = {
  authorize: [] as Array<{ product: Product | null; scope: string; accessType: string | null; prompt: string | null; pkce: string | null; redirectUri: string | null }>,
  tokens: [] as Array<{ grantType: string; product: Product | null; ok: boolean }>,
  calls: {} as Record<string, number>,
  /** Every call to the Business Profile hosts, with its answer status (quota 0 shows as 429). */
  businessProfile: [] as Array<{ path: string; status: number; at: string }>,
  searchConsole: { sites: 0, queries: 0 },
};
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
};
const productForScope = (scope: string): Product | null => (Object.entries(SCOPES).find(([, s]) => s === scope)?.[0] as Product | undefined) ?? null;
const base64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A Business Profile access token from the reused fake (it checks `Bearer access-<n>` on every call). */
async function bpToken(): Promise<string> {
  const r = await bp.fetch(GOOGLE_TOKEN_URL, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token' }) });
  return ((await r.json()) as { access_token: string }).access_token;
}

async function handleGoogle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://fake-google');
  const body = await readBody(req);
  if (url.pathname === '/__fake/state') {
    return json(res, 200, {
      site: { requests: siteRequests, fixtureRequests: fixture.requests },
      wordpress: { writes: wp.state.writes, writeCount: wp.state.writeCount, items: wp.state.items, calls: wp.calls.map((c) => ({ method: c.method, url: c.url })) },
      google: { ...google, bpQuotaZero: bp.state.quotaZero },
      data: { scDays, scQueries, scTotals, scProperties: SC_PROPERTIES, perfDays, perfSeries, reviews, keywords: bp.state.keywords, location: bp.state.locations[0] },
    });
  }
  if (url.pathname === '/__fake/wordpress/edit-on-next-read' && req.method === 'POST') {
    const { id, raw } = JSON.parse(body.toString('utf8')) as { id: number; raw: string };
    wp.state.beforeSingleGet = (item) => {
      if (item.id !== id) return;
      item.raw = raw;
      item.modified = '2026-11-14T09:30:00';
      wp.state.beforeSingleGet = null;
    };
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/__fake/business-profile' && req.method === 'POST') {
    const { quotaZero } = JSON.parse(body.toString('utf8')) as { quotaZero: boolean };
    bp.state.quotaZero = quotaZero;
    return json(res, 200, { ok: true });
  }
  const [, host = '', ...rest] = url.pathname.split('/');
  const path = `/${rest.join('/')}`;
  const key = `${req.method} ${host}${path.replace(/\/sites\/[^/]+\/searchAnalytics/, '/sites/{site}/searchAnalytics').replace(/locations\/\d+/, 'locations/{id}')}`;
  google.calls[key] = (google.calls[key] ?? 0) + 1;

  // The consent screen: approves at once, as the owner clicking "Allow" would, and sends the browser back.
  if (host === 'accounts.google.com' && path === '/o/oauth2/v2/auth') {
    const q = url.searchParams;
    const scope = q.get('scope') ?? '';
    const product = productForScope(scope);
    google.authorize.push({ product, scope, accessType: q.get('access_type'), prompt: q.get('prompt'), pkce: q.get('code_challenge_method'), redirectUri: q.get('redirect_uri') });
    const redirectUri = q.get('redirect_uri');
    if (!product || q.get('client_id') !== CLIENT_ID || !redirectUri || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('The fake Google consent screen refused this request.');
      return;
    }
    const code = `code-${base64url(randomBytes(12))}`;
    codes.set(code, { product, challenge: q.get('code_challenge') ?? '', redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    back.searchParams.set('scope', scope);
    res.writeHead(302, { location: back.toString() });
    res.end();
    return;
  }
  if (host === 'oauth2.googleapis.com' && path === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(body.toString('utf8'));
    const grantType = form.get('grant_type') ?? '';
    if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
      google.tokens.push({ grantType, product: null, ok: false });
      return json(res, 401, { error: 'invalid_client' });
    }
    if (grantType === 'authorization_code') {
      const entry = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!entry || entry.redirectUri !== form.get('redirect_uri') || base64url(createHash('sha256').update(verifier).digest()) !== entry.challenge) {
        google.tokens.push({ grantType, product: entry?.product ?? null, ok: false });
        return json(res, 400, { error: 'invalid_grant' });
      }
      google.tokens.push({ grantType, product: entry.product, ok: true });
      const access = entry.product === 'business_profile' ? await bpToken() : `sc-access-${base64url(randomBytes(9))}`;
      if (entry.product === 'search_console') scTokens.add(access);
      return json(res, 200, { access_token: access, refresh_token: `${entry.product}-refresh`, expires_in: 3599, scope: SCOPES[entry.product], token_type: 'Bearer' });
    }
    if (grantType === 'refresh_token') {
      const product: Product | null = form.get('refresh_token') === 'business_profile-refresh' ? 'business_profile' : form.get('refresh_token') === 'search_console-refresh' ? 'search_console' : null;
      google.tokens.push({ grantType, product, ok: Boolean(product) });
      if (!product) return json(res, 400, { error: 'invalid_grant' });
      const access = product === 'business_profile' ? await bpToken() : `sc-access-${base64url(randomBytes(9))}`;
      if (product === 'search_console') scTokens.add(access);
      return json(res, 200, { access_token: access, expires_in: 3599, scope: SCOPES[product], token_type: 'Bearer' });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }
  if (host === 'oauth2.googleapis.com' && path === '/revoke') return json(res, 200, {});

  if (host === 'searchconsole.googleapis.com') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!scTokens.has(token)) return json(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    if (path === '/webmasters/v3/sites' && req.method === 'GET') {
      google.searchConsole.sites++;
      return json(res, 200, { siteEntry: SC_PROPERTIES });
    }
    const m = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(path);
    if (m && req.method === 'POST') {
      google.searchConsole.queries++;
      const site = decodeURIComponent(m[1] ?? '');
      if (!SC_PROPERTIES.some((p) => p.siteUrl === site && p.permissionLevel !== 'siteUnverifiedUser')) return json(res, 403, { error: { code: 403, message: 'User does not have sufficient permission for site.' } });
      const q = JSON.parse(body.toString('utf8')) as { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number; startRow?: number };
      const inWindow = (d: string) => d >= q.startDate && d <= q.endDate;
      const all =
        q.dimensions.length === 1
          ? scTotals.filter((t) => inWindow(t.date)).map((t) => ({ keys: [t.date], clicks: t.clicks, impressions: t.impressions, ctr: t.clicks / t.impressions, position: t.position }))
          : scQueries.filter((r) => inWindow(r.date)).map((r) => ({ keys: [r.date, r.query], clicks: r.clicks, impressions: r.impressions, ctr: r.clicks / r.impressions, position: r.position }));
      const start = q.startRow ?? 0;
      const rows = all.slice(start, start + (q.rowLimit ?? 1000));
      return json(res, 200, rows.length ? { rows, responseAggregationType: 'byProperty' } : { responseAggregationType: 'byProperty' });
    }
    return json(res, 404, { error: { code: 404 } });
  }

  if (/^(mybusinessaccountmanagement|mybusinessbusinessinformation|mybusiness|businessprofileperformance)\.googleapis\.com$/.test(host)) {
    const headers: Record<string, string> = {};
    if (req.headers.authorization) headers['authorization'] = req.headers.authorization;
    const answer = await bp.fetch(`https://${host}${path}${url.search}`, { method: req.method ?? 'GET', headers });
    google.businessProfile.push({ path: `${host}${path}`, status: answer.status, at: new Date().toISOString() });
    const text = Buffer.from(await answer.arrayBuffer());
    res.writeHead(answer.status, { 'content-type': 'application/json', 'content-length': String(text.length) });
    res.end(text);
    return;
  }
  return json(res, 404, { error: { code: 404, message: `The fake has no ${host}${path}` } });
}

const googleServer = http.createServer((req, res) => {
  handleGoogle(req, res).catch((err: unknown) => json(res, 500, { error: { code: 500, message: err instanceof Error ? err.message : String(err) } }));
});

const listen = (server: http.Server, port: number) => new Promise<number>((resolve) => server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
const sitePort = await listen(siteServer, SITE_PORT);
const googlePort = await listen(googleServer, GOOGLE_PORT);
console.log(JSON.stringify({ msg: 'fake stage c website listening', site: `http://${FIXTURE_HOST}:${sitePort}`, google: `http://127.0.0.1:${googlePort}`, fixturePort: fixture.port }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void Promise.all([new Promise<void>((r) => siteServer.close(() => r())), new Promise<void>((r) => googleServer.close(() => r())), fixture.close()]).then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
