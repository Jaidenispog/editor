import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Website routes against a throwaway database (TEST_DATABASE_URL) with the real CSRF guard, validation and pg-boss
 * queue (design §12.2 "Web routes"): owner-only access, CSRF refusal, the ownership confirmation and server-only
 * settings, one active check and the cool-down, apply refused without an adapter / for unsupported kinds / with stale
 * wording, the WordPress credential never echoed, and search numbers grouped from stored rows (none when not
 * connected). No website, WordPress or Google is contacted. Skipped without TEST_DATABASE_URL.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

type User = { id: string; email: string; displayName: string; role: 'owner' | 'staff' };
const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: User; expiresAt: Date } }));
vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(
  handler: unknown,
  method: string,
  url: string,
  body?: unknown,
  params: Record<string, string> = {},
  headers: Record<string, string> = { origin: ORIGIN },
): Promise<{ status: number; json: any }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

suite('Website routes (database-backed)', () => {
  const dbName = `sa_websitetest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  const as = (u: User) => {
    auth.session = { sessionId: `s-${u.id}`, user: u, expiresAt: new Date(Date.now() + 3600_000) };
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    process.env.DATABASE_URL = url.toString();
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';
    process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.STORAGE_DRIVER = 'local';
    process.env.AI_PROVIDER = 'none';
    const authLib = await import('../src/lib/auth');
    const o = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    owner = { id: o.id, email: o.email, displayName: o.displayName, role: 'owner' };
    staff = { id: randomUUID(), email: 'staff@example.com', displayName: 'Staff', role: 'staff' };
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    await getDb().insert(schema.users).values({ id: staff.id, email: staff.email, displayName: staff.displayName, passwordHash: 'x', role: 'staff' });
    as(owner);
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
  }, 60_000);

  it('is owner-only and refuses cross-site requests', async () => {
    const overview = await import('../src/app/api/website/route');
    const audits = await import('../src/app/api/website/audits/route');
    as(staff);
    expect((await call(overview.GET, 'GET', '/api/website')).status).toBe(403);
    expect((await call(audits.POST, 'POST', '/api/website/audits', {})).status).toBe(403);
    as(owner);
    const csrf = await call(audits.POST, 'POST', '/api/website/audits', {}, {}, { origin: 'https://evil.example' });
    expect(csrf.status).toBe(403);
    const ok = await call(overview.GET, 'GET', '/api/website');
    expect(ok.status).toBe(200);
    expect(ok.json.setup).toMatchObject({ websiteValid: false, ownershipConfirmed: false });
    expect(ok.json.checkBlockedReason).toMatch(/website address/);
  });

  it('confirms ownership only through its own route; PUT /api/settings cannot set it', async () => {
    const settingsRoute = await import('../src/app/api/settings/route');
    const ownership = await import('../src/app/api/website/ownership/route');
    expect((await call(ownership.POST, 'POST', '/api/website/ownership', { confirm: true })).status).toBe(400);
    const put = await call(settingsRoute.PUT, 'PUT', '/api/settings', {
      business: { website: 'https://www.ivanhoebarber.example.com.au/' },
      website: { ownershipConfirmedHost: 'ivanhoebarber.example.com.au', placeTerms: ['Heidelberg'] },
    });
    expect(put.status).toBe(200);
    expect(put.json.settings.website).toMatchObject({ ownershipConfirmedHost: null, placeTerms: ['Heidelberg'] });
    const res = await call(ownership.POST, 'POST', '/api/website/ownership', { confirm: true });
    expect(res.status).toBe(200);
    expect(res.json.host).toBe('ivanhoebarber.example.com.au');
  });

  it('starts one check at a time (409 while one is active) and honours the cool-down', async () => {
    const audits = await import('../src/app/api/website/audits/route');
    const first = await call(audits.POST, 'POST', '/api/website/audits', {});
    expect(first.status).toBe(202);
    expect(first.json.job.type).toBe('website.audit');
    expect(first.json.audit.status).toBe('queued');
    const second = await call(audits.POST, 'POST', '/api/website/audits', {});
    expect(second.status).toBe(409);
    expect(second.json.error.message).toMatch(/already running/);
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    await getDb().update(schema.websiteAudits).set({ status: 'complete', finishedAt: new Date(), summary: {} }).where(eq(schema.websiteAudits.id, first.json.audit.id));
    const cooling = await call(audits.POST, 'POST', '/api/website/audits', {});
    expect(cooling.status).toBe(409);
    expect(cooling.json.error.message).toMatch(/Try again in a few minutes/);
    const list = await call(audits.GET, 'GET', '/api/website/audits');
    expect(list.json.audits).toHaveLength(1);
  });

  it('refuses to apply without a connected adapter, for unsupported kinds and with stale wording; never echoes the WordPress password', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const apply = await import('../src/app/api/website/edits/[id]/apply/route');
    const edits = await import('../src/app/api/website/edits/route');
    const wordpress = await import('../src/app/api/integrations/website/wordpress/route');
    const textId = randomUUID();
    const titleId = randomUUID();
    await getDb()
      .insert(schema.websiteEdits)
      .values([
        {
          id: textId,
          title: 'Correct text',
          pageUrl: 'https://www.ivanhoebarber.example.com.au/contact/',
          proposedChange: { kind: 'text_replace', pageUrl: 'https://www.ivanhoebarber.example.com.au/contact/', before: '(03) 9876 5432', after: '03 9499 1234' },
        },
        {
          id: titleId,
          title: 'Rewrite the home page title',
          pageUrl: 'https://www.ivanhoebarber.example.com.au/',
          proposedChange: { kind: 'page_title', pageUrl: 'https://www.ivanhoebarber.example.com.au/', before: 'Home', after: 'Ivanhoe Barber Co | Barber in Ivanhoe' },
        },
      ]);
    const noAdapter = await call(apply.POST, 'POST', `/api/website/edits/${textId}/apply`, { confirm: true, expectedAfter: '03 9499 1234' }, { id: textId });
    expect(noAdapter.status).toBe(422);
    expect(noAdapter.json.error.message).toMatch(/Connect WordPress/);

    expect(
      (await call(wordpress.POST, 'POST', '/api/integrations/website/wordpress', { baseUrl: 'http://insecure.example', username: 'u', applicationPassword: 'abcd efgh ijkl mnop' }))
        .status,
    ).toBe(400);
    for (const baseUrl of ['https://10.0.0.5/', 'https://[::1]/', 'https://169.254.169.254/', 'https://localhost/', 'https://wordpress/', 'https://nas.local/']) {
      const refused = await call(wordpress.POST, 'POST', '/api/integrations/website/wordpress', { baseUrl, username: 'u', applicationPassword: 'abcd efgh ijkl mnop' });
      expect(refused.status, baseUrl).toBe(400);
      expect(refused.json.error.message).toMatch(/not a public website/);
    }
    const saved = await call(wordpress.POST, 'POST', '/api/integrations/website/wordpress', {
      baseUrl: 'https://staging.ivanhoebarber.example.com.au/',
      username: 'studio-assistant',
      applicationPassword: 'abcd efgh ijkl mnop',
    });
    expect(saved.status).toBe(202);
    expect(JSON.stringify(saved.json)).not.toContain('abcd efgh');
    const conn = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'website') });
    expect(conn?.accessTokenEncrypted).not.toContain('abcd');
    expect(conn?.config).toEqual({ baseUrl: 'https://staging.ivanhoebarber.example.com.au' });
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'integration.website.connected'));
    expect(JSON.stringify(audit)).not.toContain('abcd efgh');
    // Pretend the read-only check passed (the worker does this).
    await getDb()
      .update(schema.integrationConnections)
      .set({ status: 'connected', capabilities: { supportedKinds: 'text_replace,image_alt_text', environment: 'staging' } })
      .where(eq(schema.integrationConnections.provider, 'website'));

    const unsupported = await call(
      apply.POST,
      'POST',
      `/api/website/edits/${titleId}/apply`,
      { confirm: true, expectedAfter: 'Ivanhoe Barber Co | Barber in Ivanhoe' },
      { id: titleId },
    );
    expect(unsupported.status).toBe(422);
    expect(unsupported.json.error.message).toMatch(/can't change page titles/);
    const stale = await call(apply.POST, 'POST', `/api/website/edits/${textId}/apply`, { confirm: true, expectedAfter: 'something else' }, { id: textId });
    expect(stale.status).toBe(409);
    expect((await call(apply.POST, 'POST', `/api/website/edits/${textId}/apply`, { expectedAfter: '03 9499 1234' }, { id: textId })).status).toBe(400);
    const ok = await call(apply.POST, 'POST', `/api/website/edits/${textId}/apply`, { confirm: true, expectedAfter: '03 9499 1234' }, { id: textId });
    expect(ok.status).toBe(202);
    expect(ok.json.edit).toMatchObject({ status: 'approved', destination: { host: 'staging.ivanhoebarber.example.com.au', environment: 'staging' } });
    expect(ok.json.job.type).toBe('website.edit_apply');
    const row = await getDb().query.websiteEdits.findFirst({ where: eq(schema.websiteEdits.id, textId) });
    expect(row?.approvedBy).toBe(owner.id);
    const open = await call(edits.GET, 'GET', '/api/website/edits?status=open');
    const dto = open.json.edits.find((e: { id: string }) => e.id === titleId);
    expect(dto.applyAvailable.ok).toBe(false);
    expect(dto.instructions.text).toContain('Replace:  Home');
    expect(JSON.stringify(open.json)).not.toContain('abcd efgh');
  });

  it('edits wording with soft warnings, marks done, dismisses, and refuses AI drafts when AI is not set up', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const patch = await import('../src/app/api/website/edits/[id]/route');
    const draft = await import('../src/app/api/website/edits/[id]/draft/route');
    const done = await import('../src/app/api/website/edits/[id]/mark-done/route');
    const reject = await import('../src/app/api/website/edits/[id]/reject/route');
    const id = randomUUID();
    const page = 'https://www.ivanhoebarber.example.com.au/services/';
    await getDb()
      .insert(schema.websiteEdits)
      .values({ id, title: 'Title', pageUrl: page, proposedChange: { kind: 'page_title', pageUrl: page, before: 'Services', after: 'Services | Ivanhoe Barber Co' } });
    const short = await call(patch.PATCH, 'PATCH', `/api/website/edits/${id}`, { after: 'Too short' }, { id });
    expect(short.status).toBe(400);
    const warned = await call(patch.PATCH, 'PATCH', `/api/website/edits/${id}`, { after: 'The best barber in Ivanhoe, VIC' }, { id });
    expect(warned.status).toBe(200);
    expect(warned.json.edit.source).toBe('owner');
    expect(warned.json.warnings.length).toBeGreaterThan(0);
    expect((await call(draft.POST, 'POST', `/api/website/edits/${id}/draft`, {}, { id })).status).toBe(422);
    const marked = await call(done.POST, 'POST', `/api/website/edits/${id}/mark-done`, {}, { id });
    expect(marked.json.edit).toMatchObject({ status: 'applied', appliedVia: 'manual', verification: 'pending' });
    expect((await call(reject.POST, 'POST', `/api/website/edits/${id}/reject`, {}, { id })).status).toBe(409);
  });

  it('a removal applied through WordPress offers no undo (its reverse could never find the text)', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const edits = await import('../src/app/api/website/edits/route');
    const undo = await import('../src/app/api/website/edits/[id]/undo/route');
    const removal = randomUUID();
    const replacement = randomUUID();
    const page = 'https://www.ivanhoebarber.example.com.au/contact/';
    await getDb()
      .insert(schema.websiteEdits)
      .values([
        { id: removal, title: 'Remove old offer', pageUrl: page, status: 'applied', appliedVia: 'wordpress', proposedChange: { kind: 'text_replace', pageUrl: page, before: 'Half price Tuesdays!', after: '' } },
        { id: replacement, title: 'Correct text', pageUrl: page, status: 'applied', appliedVia: 'wordpress', proposedChange: { kind: 'text_replace', pageUrl: page, before: '(03) 9876 5432', after: '03 9499 1234' } },
      ]);
    const done = (await call(edits.GET, 'GET', '/api/website/edits?status=done')).json.edits as Array<{ id: string; canUndo: boolean }>;
    expect(done.find((e) => e.id === removal)?.canUndo).toBe(false);
    expect(done.find((e) => e.id === replacement)?.canUndo).toBe(true);
    const refused = await call(undo.POST, 'POST', `/api/website/edits/${removal}/undo`, {}, { id: removal });
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toMatch(/revisions in WordPress/);
  });

  it('shows no search numbers until Search Console is connected with a property, then groups stored rows', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const perf = await import('../src/app/api/website/search-performance/route');
    const property = await import('../src/app/api/integrations/google-search-console/property/route');
    const groups = await import('../src/app/api/website/query-groups/route');
    const none = await call(perf.GET, 'GET', '/api/website/search-performance');
    expect(none.json).toMatchObject({ state: 'not_connected', groups: null, notListed: null, daily: [] });
    await getDb()
      .insert(schema.integrationConnections)
      .values({
        id: randomUUID(),
        provider: 'google_search_console',
        status: 'connected',
        config: {
          properties: [
            { siteUrl: 'sc-domain:ivanhoebarber.example.com.au', permissionLevel: 'siteOwner' },
            { siteUrl: 'https://other.example/', permissionLevel: 'siteUnverifiedUser' },
          ],
        },
      });
    expect((await call(perf.GET, 'GET', '/api/website/search-performance')).json.state).toBe('choose_property');
    expect((await call(property.PUT, 'PUT', '/api/integrations/google-search-console/property', { siteUrl: 'https://other.example/' })).status).toBe(400);
    const chosen = await call(property.PUT, 'PUT', '/api/integrations/google-search-console/property', { siteUrl: 'sc-domain:ivanhoebarber.example.com.au' });
    expect(chosen.status).toBe(200);
    expect(chosen.json.job.type).toBe('search.sync');
    await getDb().update(schema.jobs).set({ status: 'succeeded' }).where(eq(schema.jobs.type, 'search.sync'));
    expect((await call(perf.GET, 'GET', '/api/website/search-performance')).json).toMatchObject({ state: 'no_data', groups: null });
    const p = 'sc-domain:ivanhoebarber.example.com.au';
    const row = (d: string, kind: 'total' | 'query', key: string, clicks: number, impressions: number, position: number) => ({
      id: randomUUID(),
      source: 'search_console' as const,
      property: p,
      granularity: 'day' as const,
      periodStart: d,
      kind,
      key,
      clicks,
      impressions,
      position,
    });
    await getDb()
      .insert(schema.searchMetrics)
      .values([
        row('2026-11-10', 'total', '', 9, 400, 8),
        row('2026-11-10', 'query', 'barber ivanhoe', 3, 150, 5),
        row('2026-11-10', 'query', 'ivanhoebarber', 5, 50, 1),
        row('2026-11-11', 'query', 'skin fade heidelberg', 1, 30, 9),
      ]);
    expect((await call(groups.PUT, 'PUT', '/api/website/query-groups', { placeTerms: [] })).status).toBe(200);
    const before = await call(perf.GET, 'GET', '/api/website/search-performance?range=28d');
    expect(before.json).toMatchObject({ state: 'connected', dataThrough: '2026-11-11', notListed: { clicks: 1, impressions: 200 } });
    expect(before.json.groups.local.impressions).toBe(150);
    expect(before.json.groups.service.impressions).toBe(30);
    // Edited lists regroup stored history at once.
    expect((await call(groups.PUT, 'PUT', '/api/website/query-groups', { placeTerms: ['Heidelberg'] })).status).toBe(200);
    const after = await call(perf.GET, 'GET', '/api/website/search-performance?range=28d');
    expect(after.json.groups.local.impressions).toBe(180);
    expect((await call(perf.GET, 'GET', '/api/website/search-performance?range=1y')).status).toBe(400);
  });
});
