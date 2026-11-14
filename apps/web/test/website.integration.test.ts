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

  it('binds an approval to the old text, the new text and the destination; keeps audit text short; new wording drops a write marker', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const { approvalHash } = await import('@studio/core/website-approval');
    const apply = await import('../src/app/api/website/edits/[id]/apply/route');
    const patch = await import('../src/app/api/website/edits/[id]/route');
    const choose = await import('../src/app/api/website/edits/[id]/choose-draft/route');
    await getDb()
      .update(schema.integrationConnections)
      .set({ status: 'connected', config: { baseUrl: 'https://staging.ivanhoebarber.example.com.au' }, capabilities: { supportedKinds: 'text_replace,image_alt_text', environment: 'staging' } })
      .where(eq(schema.integrationConnections.provider, 'website'));
    const page = 'https://www.ivanhoebarber.example.com.au/about/';
    const long = `${'Fades, tapers and beard trims for every age in Ivanhoe. '.repeat(5)}Since 2015.`;
    const change = { kind: 'text_replace' as const, pageUrl: page, before: long, after: long.replace('2015', '2016') };
    const id = randomUUID();
    const marker = { writeSentAt: '2026-11-14T03:00:00.000Z', preWriteHash: 'a'.repeat(64), changeHash: 'b'.repeat(64), resourceId: '12', outcome: 'error' as const, message: 'x' };
    await getDb().insert(schema.websiteEdits).values({ id, title: 'About', pageUrl: page, proposedChange: change, status: 'apply_failed', applyResult: marker, aiOptions: ['Option one'] });
    const destination = { host: 'staging.ivanhoebarber.example.com.au', environment: 'staging' };
    // The old text the dialog showed is no longer the change's (a check refreshed it): 409, nothing approved.
    const staleBefore = await call(apply.POST, 'POST', `/api/website/edits/${id}/apply`, { confirm: true, expectedAfter: change.after, expectedBefore: 'something else', expectedDestination: destination }, { id });
    expect(staleBefore.status).toBe(409);
    // The dialog showed another WordPress site (the connection was saved again since): 409.
    const otherSite = await call(
      apply.POST,
      'POST',
      `/api/website/edits/${id}/apply`,
      { confirm: true, expectedAfter: change.after, expectedBefore: change.before, expectedDestination: { host: 'old.ivanhoebarber.example.com.au', environment: 'staging' } },
      { id },
    );
    expect(otherSite.status).toBe(409);
    expect(otherSite.json.error.message).toMatch(/WordPress connection changed/);
    expect((await getDb().query.websiteEdits.findFirst({ where: eq(schema.websiteEdits.id, id) }))?.status).toBe('apply_failed');
    const ok = await call(apply.POST, 'POST', `/api/website/edits/${id}/apply`, { confirm: true, expectedAfter: change.after, expectedBefore: change.before, expectedDestination: destination }, { id });
    expect(ok.status).toBe(202);
    const approved = await getDb().query.websiteEdits.findFirst({ where: eq(schema.websiteEdits.id, id) });
    // The approval is stored beside the earlier attempt's marker (the worker decides with both).
    expect(approved?.applyResult).toMatchObject({
      ...marker,
      approvalHash: approvalHash(change, { baseUrl: 'https://staging.ivanhoebarber.example.com.au', environment: 'staging' }),
    });
    const requested = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'website.edit.apply_requested'));
    const entry = requested.find((r) => r.entityId === id)?.data as { before: string; after: string };
    expect(long.length).toBeGreaterThan(200);
    expect(entry.before).toHaveLength(200);
    expect(entry.after).toHaveLength(200);

    // Back to apply_failed with a marker (as the worker leaves it): new wording, or an AI option, drops the marker.
    await getDb().update(schema.websiteEdits).set({ status: 'apply_failed', applyResult: marker }).where(eq(schema.websiteEdits.id, id));
    const longer = `${long} Walk-ins welcome. `.repeat(3).trim();
    expect((await call(patch.PATCH, 'PATCH', `/api/website/edits/${id}`, { after: longer.slice(0, 480) }, { id })).status).toBe(200);
    const patched = await getDb().query.websiteEdits.findFirst({ where: eq(schema.websiteEdits.id, id) });
    expect(patched?.applyResult).toEqual({ resourceId: '12', outcome: 'error', message: 'x' });
    const edited = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'website.edit.edited'));
    expect((edited.find((r) => r.entityId === id)?.data as { after: string }).after).toHaveLength(200);
    await getDb().update(schema.websiteEdits).set({ applyResult: marker }).where(eq(schema.websiteEdits.id, id));
    expect((await call(choose.POST, 'POST', `/api/website/edits/${id}/choose-draft`, { index: 0 }, { id })).status).toBe(200);
    const chosen = await getDb().query.websiteEdits.findFirst({ where: eq(schema.websiteEdits.id, id) });
    expect(chosen?.applyResult.writeSentAt).toBeUndefined();
    expect(chosen?.applyResult.changeHash).toBeUndefined();
  });

  it('an edit or AI option that loses the race to an apply never changes the wording the owner approved', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const patch = await import('../src/app/api/website/edits/[id]/route');
    const choose = await import('../src/app/api/website/edits/[id]/choose-draft/route');
    const page = 'https://www.ivanhoebarber.example.com.au/prices/';
    const change = { kind: 'meta_description' as const, pageUrl: page, before: null, after: 'Prices for fades, tapers and beard trims at Ivanhoe Barber Co in Ivanhoe, VIC.' };
    // A second connection holds the row the way the apply does (approve, then the worker's claim) and commits only once
    // the edit is waiting on it: the edit read "proposed" before, and must still not overwrite the approved wording.
    const race = async (status: 'approved' | 'applying', edit: (id: string) => Promise<{ status: number; json: any }>) => {
      const id = randomUUID();
      await getDb().insert(schema.websiteEdits).values({ id, title: 'Prices', pageUrl: page, proposedChange: change, aiOptions: ['A different description for the prices page, written by the AI step for Ivanhoe.'] });
      const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await other.connect();
      try {
        await other.query('BEGIN');
        await other.query(`UPDATE website_edits SET status = $1, approved_by = $2, approved_at = now() WHERE id = $3`, [status, owner.id, id]);
        const pending = edit(id);
        let blocked = false;
        // Wait until the edit's conditional UPDATE is blocked on this transaction's row lock (statistics are a snapshot
        // inside a transaction, so it is cleared before each look).
        for (let i = 0; i < 200; i++) {
          await other.query('SELECT pg_stat_clear_snapshot()');
          const waiting = await other.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query ILIKE 'update "website_edits"%'`,
          );
          if (waiting.rows[0].n > 0) {
            blocked = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(blocked).toBe(true);
        await other.query('COMMIT');
        const res = await pending;
        expect(res.status).toBe(409);
        expect(res.json.error.message).toMatch(/being applied/);
      } finally {
        await other.end();
      }
      const row = await getDb().query.websiteEdits.findFirst({ where: eq(schema.websiteEdits.id, id) });
      expect(row?.status).toBe(status);
      expect(row?.proposedChange).toEqual(change);
    };
    for (const status of ['approved', 'applying'] as const) {
      await race(status, (id) =>
        call(patch.PATCH, 'PATCH', `/api/website/edits/${id}`, { after: 'An owner rewrite of the prices page description for Ivanhoe Barber Co, VIC.' }, { id }),
      );
      await race(status, (id) => call(choose.POST, 'POST', `/api/website/edits/${id}/choose-draft`, { index: 0 }, { id }));
    }
  });

  it('disconnecting Search Console with "Also delete stored search data" removes every stored property’s rows', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const gsc = await import('../src/app/api/integrations/google-search-console/route');
    const row = (property: string) => ({
      id: randomUUID(),
      source: 'search_console' as const,
      property,
      granularity: 'day' as const,
      periodStart: '2026-11-09',
      kind: 'total' as const,
      key: '',
      clicks: 1,
      impressions: 10,
      position: 5,
    });
    // Rows from the chosen property and from one chosen earlier (choosing another property keeps old rows).
    await getDb().insert(schema.searchMetrics).values([row('https://other.example/'), row('sc-domain:ivanhoebarber.example.com.au')]);
    expect((await call(gsc.DELETE, 'DELETE', '/api/integrations/google-search-console?deleteData=true')).status).toBe(202);
    expect(await getDb().select().from(schema.searchMetrics).where(eq(schema.searchMetrics.source, 'search_console'))).toEqual([]);
  });

  it('a check that read no page is never "fixed since last check" nor "nothing to fix"', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const core = await import('@studio/core');
    const { findingsNote, countsLine } = await import('../src/components/website/check-words');
    const overview = await import('../src/app/api/website/route');
    const one = await import('../src/app/api/website/audits/[id]/route');
    const root = 'https://ivanhoebarber.example.com.au/';
    const facts = (pages: unknown[]) => ({
      version: 1,
      siteRoot: root,
      settingsSnapshot: { businessName: 'Ivanhoe Barber Co', addressLine: '', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', phone: '', website: root, bookingLink: '', openingHours: [] },
      platformHint: 'unknown',
      robots: { status: 'ok', sitemaps: [], googlebotBlocksHome: false, blockedForUs: [], crawlDelaySec: null, googlebotBlockedPages: [] },
      sitemap: { found: false, sources: [], urlCount: 0, invalid: false, sample: [], homeListed: null, badUrls: [] },
      hostVariants: [],
      soft404: null,
      pages,
      links: { checked: 0, broken: [], unverifiable: 0 },
      limits: { maxPages: 25, hitPageLimit: false, requests: 3, durationMs: 1000 },
    });
    const home = {
      url: root, finalUrl: root, status: 200, error: null, skipped: null, redirectChain: [], ttfbMs: 100, totalMs: 200, htmlBytes: 1000, compressed: true,
      title: 'Ivanhoe Barber Co', metaDescription: null, h1: ['Welcome'], headings: [], canonical: root, metaRobots: null, xRobotsTag: null, lang: 'en-AU',
      viewport: 'width=device-width', jsonLd: [], microdataTypes: [],
      nap: { phones: [], telLinks: [], nameFound: true, suburbFound: true, postcodeFound: false, streetFound: false, addressConflicts: [] },
      bookingLinkFound: false, images: [], headScripts: { total: 0, blocking: 0 }, estimatedWeightBytes: 1000, wordCount: 100, textSample: null, internalLinks: [],
    };
    const finding = core.buildFinding('canonical_missing', root, { detail: 'No canonical address on the home page.', pages: [root] });
    const earlier = core.WebsiteAuditResultSchema.parse({ ...facts([home]), findings: [finding] });
    const notRead = core.WebsiteAuditResultSchema.parse({ ...facts([]), findings: [] });
    const reason = "Your home page forwards to an address your robots.txt asks automated tools not to read, so we didn't check your pages.";
    const t = Date.now() + 3_600_000; // newer than every check the earlier tests made
    const earlierId = randomUUID();
    const laterId = randomUUID();
    await getDb()
      .insert(schema.websiteAudits)
      .values([
        { id: earlierId, url: root, status: 'complete', result: earlier, summary: core.summariseAudit(earlier, []), createdAt: new Date(t), finishedAt: new Date(t) },
        { id: laterId, url: root, status: 'partial', result: notRead, summary: core.summariseAudit(notRead, [reason]), createdAt: new Date(t + 60_000), finishedAt: new Date(t + 60_000) },
      ]);
    const res = await call(overview.GET, 'GET', '/api/website');
    expect(res.status).toBe(200);
    expect(res.json.latestAudit.id).toBe(laterId);
    expect(res.json.latestAudit.summary.pagesChecked).toBe(0);
    expect(res.json.fixedSinceLast).toEqual([]);
    expect(res.json.pagesNotRead).toEqual({ reasons: [reason] });
    const detail = await call(one.GET, 'GET', `/api/website/audits/${laterId}`, undefined, { id: laterId });
    expect(detail.json.fixedSinceLast).toEqual([]);
    expect(detail.json.pagesNotRead).toEqual({ reasons: [reason] });
    // What the page says for it: never "nothing to fix", always that the pages couldn't be checked, with the reason.
    const note = findingsNote(res.json.latestResult.findings.length, res.json.pagesNotRead) ?? '';
    expect(note).not.toMatch(/nothing to fix/i);
    expect(note).toContain("We couldn't check your pages this time.");
    expect(note).toContain(reason);
    expect(countsLine(res.json.latestAudit.summary)).not.toMatch(/nothing to fix/i);
    // The earlier real check still reads as its own result.
    const earlierDetail = await call(one.GET, 'GET', `/api/website/audits/${earlierId}`, undefined, { id: earlierId });
    expect(earlierDetail.json.pagesNotRead).toBeNull();
    expect(findingsNote(0, null)).toMatch(/nothing to fix/);
    // A later check that reads pages again is compared with the last check that read pages, not the empty one.
    const fixedId = randomUUID();
    const fixed = core.WebsiteAuditResultSchema.parse({ ...facts([home]), findings: [] });
    await getDb()
      .insert(schema.websiteAudits)
      .values({ id: fixedId, url: root, status: 'complete', result: fixed, summary: core.summariseAudit(fixed, []), createdAt: new Date(t + 120_000), finishedAt: new Date(t + 120_000) });
    const after = await call(overview.GET, 'GET', '/api/website');
    expect(after.json.pagesNotRead).toBeNull();
    expect(after.json.fixedSinceLast).toEqual([finding.title]);
  });
});
