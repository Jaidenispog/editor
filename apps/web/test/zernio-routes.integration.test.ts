import { createHash, createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * TikTok through Zernio, web side, against a throwaway database (TEST_DATABASE_URL): the key connect (encrypted, only
 * the last four characters shown), the account choice, the composer's Zernio options, consent-tick approval with the
 * interaction choices bound to the target, the drafts switch and draft verification, the webhook route (signed →
 * stored under the event id; badly signed → `unverified:`; a redelivery → one row, one job; only an envelope kept)
 * and disconnect. The web app never calls Zernio, so no fake server is needed and nothing is ever sent.
 * Skipped when TEST_DATABASE_URL is unset.
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
vi.mock('../src/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/env')>();
  const { loadEnv } = await import('@studio/config');
  return { ...actual, getEnv: () => loadEnv({ ...process.env }) };
});

const ORIGIN = 'http://localhost:3000';
const KEY = 'sk_test_0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const SECRET = 'webhook-secret-for-tests-0123456789abcdef';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }, raw?: string): Promise<{ status: number; json: any; text: string }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.clone().text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const signIn = (user: User) => {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
};

function plan() {
  const seg = (id: string, inSec: number, outSec: number, role: string) => ({ id, assetId: 'a1', inSec, outSec, speed: 1, framing: { mode: 'centre', focusX: 0.5, focusY: 0.5 }, zoom: null, transitionIn: null, role, keepOriginalSound: false });
  return {
    version: 1,
    styleId: 'clean_promo',
    title: 'Fade',
    description: '',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: 10,
    segments: [seg('s1', 0, 5, 'cutting'), seg('s2', 6, 11, 'result')],
    textOverlays: [],
    captions: [],
    audio: { music: null, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'natural',
  };
}

suite('TikTok through Zernio: routes (database-backed)', () => {
  const dbName = `sa_zerniotest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  const ids = { project: randomUUID(), edit: randomUUID(), v1: randomUUID() };

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
    process.env.TIKTOK_PUBLISH_PROVIDER = 'zernio';
    // Never contacted: the web app only stores the key and queues the worker's read-only check.
    process.env.ZERNIO_API_BASE_URL = 'http://127.0.0.1:9/api';
    process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const db = getDb();
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@example.com`, displayName: name, role };
      await db.insert(schema.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Jordan');
    await db.insert(schema.projects).values({ id: ids.project, ownerId: owner.id, title: 'Skin fade' });
    const gen = randomUUID();
    await db.insert(schema.generations).values({ id: gen, projectId: ids.project, requestedBy: owner.id, settings: { durationSec: 10, styles: ['clean_promo'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null } });
    await db.insert(schema.edits).values({ id: ids.edit, projectId: ids.project, generationId: gen, styleId: 'clean_promo', slot: 0 });
    await db.insert(schema.editVersions).values({ id: ids.v1, editId: ids.edit, versionNo: 1, origin: 'initial', status: 'preview_ready', plan: plan() as never });
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    delete process.env.TIKTOK_PUBLISH_PROVIDER;
    delete process.env.ZERNIO_API_BASE_URL;
    delete process.env.ZERNIO_WEBHOOK_SECRET;
  }, 60_000);

  const db = async () => (await import('../src/lib/db')).getDb();
  const sch = async () => (await import('@studio/db')).schema;
  const drizzle = async () => import('drizzle-orm');

  it('saves the key encrypted (owner only), shows only its last four characters, and queues the read-only check', async () => {
    const r = await import('../src/app/api/integrations/zernio/route');
    signIn(staff);
    expect((await call(r.POST, 'POST', '/api/integrations/zernio', {}, { apiKey: KEY })).status).toBe(403);
    signIn(owner);
    expect((await call(r.POST, 'POST', '/api/integrations/zernio', {}, { apiKey: 'short' })).status).toBe(400);
    const res = await call(r.POST, 'POST', '/api/integrations/zernio', {}, { apiKey: KEY });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'connected', keyHint: KEY.slice(-4) });
    expect(res.text).not.toContain(KEY);
    const schema = await sch();
    const { eq } = await drizzle();
    const conn = (await (await db()).query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'zernio') }))!;
    expect(conn.accessTokenEncrypted).toBeTruthy();
    expect(conn.accessTokenEncrypted).not.toContain(KEY);
    expect(conn.config['keyHint']).toBe(KEY.slice(-4));
    const jobs = await (await db()).query.jobs.findMany({ where: eq(schema.jobs.type, 'social.check') });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ connectionId: conn.id, reason: 'connect' });
    const got = await call(r.GET, 'GET', '/api/integrations/zernio');
    expect(got.json).toMatchObject({ enabled: true, configured: true, connectionStatus: 'connected', keyHint: KEY.slice(-4), account: null, webhookSigning: true, webhookUrl: `${ORIGIN}/api/webhooks/zernio` });
    expect(got.text).not.toContain(KEY);
    const audit = await (await db()).query.auditLog.findMany({ where: eq(schema.auditLog.action, 'integration.zernio.connected') });
    expect(JSON.stringify(audit)).not.toContain(KEY);
  });

  it('chooses the TikTok account from the listed candidates only; a re-chosen id keeps the row and, for the same handle, its verification', async () => {
    const r = await import('../src/app/api/integrations/zernio/account/route');
    const schema = await sch();
    const { eq } = await drizzle();
    // What the worker's read-only check stores.
    await (await db())
      .update(schema.integrationConnections)
      .set({ config: { keyHint: KEY.slice(-4), candidates: [{ id: 'acc1', username: 'ivanhoe_cuts', displayName: 'Ivanhoe Cuts', problem: null }] } })
      .where(eq(schema.integrationConnections.provider, 'zernio'));
    signIn(owner);
    expect((await call(r.POST, 'POST', '/api/integrations/zernio/account', {}, { zernioAccountId: 'not-listed' })).status).toBe(400);
    const res = await call(r.POST, 'POST', '/api/integrations/zernio/account', {}, { zernioAccountId: 'acc1' });
    expect(res.status).toBe(200);
    expect(res.json.account).toMatchObject({ username: 'ivanhoe_cuts', status: 'connected', verified: false, directPublishEnabled: false, draftsEnabled: false });
    const row = (await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.externalId, 'acc1') }))!;
    expect(row).toMatchObject({ platform: 'tiktok', provider: 'zernio' });
    // Verified earlier; Zernio then gave the same account a new id after a reconnect.
    await (await db()).update(schema.socialAccounts).set({ capabilities: { verifiedDirectAt: '2026-11-15T00:00:00Z' }, directPublishEnabled: true }).where(eq(schema.socialAccounts.id, row.id));
    await (await db())
      .update(schema.integrationConnections)
      .set({ config: { keyHint: KEY.slice(-4), candidates: [{ id: 'acc1-new', username: 'ivanhoe_cuts', displayName: 'Ivanhoe Cuts', problem: null }] } })
      .where(eq(schema.integrationConnections.provider, 'zernio'));
    await call(r.POST, 'POST', '/api/integrations/zernio/account', {}, { zernioAccountId: 'acc1-new' });
    const same = (await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, row.id) }))!;
    expect(same).toMatchObject({ externalId: 'acc1-new', directPublishEnabled: true });
    expect(same.capabilities['verifiedDirectAt']).toBe('2026-11-15T00:00:00Z');
    // A different handle starts again: unverified, switches off.
    await (await db())
      .update(schema.integrationConnections)
      .set({ config: { keyHint: KEY.slice(-4), candidates: [{ id: 'acc2', username: 'other_shop', displayName: 'Other', problem: null }] } })
      .where(eq(schema.integrationConnections.provider, 'zernio'));
    await call(r.POST, 'POST', '/api/integrations/zernio/account', {}, { zernioAccountId: 'acc2' });
    const other = (await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, row.id) }))!;
    expect(other).toMatchObject({ externalId: 'acc2', username: 'other_shop', directPublishEnabled: false });
    expect(other.capabilities['verifiedDirectAt']).toBeNull();
    // Back to the studio's account, as the check would record it (Business lane, creator-info seeds).
    await (await db())
      .update(schema.socialAccounts)
      .set({ externalId: 'acc1', username: 'ivanhoe_cuts', status: 'connected', capabilities: { businessApiLane: true, privacyPublicAllowed: true, allowCommentEnabled: true, allowCommentDefault: true, allowDuetEnabled: true, allowDuetDefault: false, allowStitchEnabled: false, allowStitchDefault: false } })
      .where(eq(schema.socialAccounts.id, row.id));
  });

  it('offers "Publish via Zernio" and "Send to TikTok drafts via Zernio" as first verification posts, with the creator-info seeds', async () => {
    const r = await import('../src/app/api/publishing/eligibility/route');
    signIn(owner);
    const res = await call(r.GET, 'GET', `/api/publishing/eligibility?versions=${ids.v1}`);
    expect(res.status).toBe(200);
    const tiktok = res.json.items[0].methods.tiktok as Array<Record<string, unknown>>;
    expect(tiktok.map((o) => [o['method'], o['delivery'] ?? null, o['available'], o['isVerification']])).toEqual([
      ['zernio', 'publish', true, true],
      ['zernio', 'draft', true, true],
      ['manual', null, true, false],
    ]);
    expect(tiktok[0]?.['tiktokInteractions']).toEqual({ allowComment: { enabled: true, default: true }, allowDuet: { enabled: true, default: false }, allowStitch: { enabled: false, default: false } });
    expect(res.json.quota.zernio).toEqual({ last24h: 0, cap: 15 });
  });

  it('approval needs the consent tick and the three choices, refuses a switch TikTok turned off, and binds what was approved', async () => {
    const posts = await import('../src/app/api/publish-posts/route');
    const approve = await import('../src/app/api/publish-posts/approve/route');
    const schema = await sch();
    const { eq } = await drizzle();
    signIn(owner);
    const created = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [{ editVersionId: ids.v1, caption: 'Fresh fade #ivanhoe', coverTimeSec: 4, mode: 'now', targets: [{ platform: 'tiktok', method: 'zernio', delivery: 'publish', variant: 'standard' }] }] });
    expect(created.status).toBe(200);
    const post = created.json.posts[0];
    expect(post.targets[0]).toMatchObject({ method: 'zernio', delivery: 'publish', isVerification: true, handle: '@ivanhoe_cuts' });
    const postIds = [post.id];
    expect((await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds })).json.error.message).toMatch(/posted publicly to TikTok/);
    expect((await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds, consent: { tiktokPublic: true } })).json.error.message).toMatch(/Comments, Duets and Stitches/);
    const stitched = await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds, consent: { tiktokPublic: true, tiktokInteractions: { allowComment: true, allowDuet: false, allowStitch: true } } });
    expect(stitched.status).toBe(400);
    expect(stitched.json.error.message).toMatch(/Stitches is turned off in your TikTok settings/);
    signIn(staff);
    expect((await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds, consent: { tiktokPublic: true, tiktokInteractions: { allowComment: true, allowDuet: false, allowStitch: false } } })).status).toBe(403);
    signIn(owner);
    const ok = await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds, consent: { tiktokPublic: true, tiktokInteractions: { allowComment: true, allowDuet: false, allowStitch: false } } });
    expect(ok.status).toBe(200);
    const t = (await (await db()).query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, post.targets[0].id) }))!;
    expect(t.providerState['consent']).toMatchObject({ tiktokPublic: true, userId: owner.id, binding: { caption: 'Fresh fade #ivanhoe', coverTimeSec: 4, variant: 'standard', delivery: 'publish', handle: 'ivanhoe_cuts', interactions: { allowComment: true, allowDuet: false, allowStitch: false } } });
  });

  it('the drafts switch waits for a confirmed draft verification, which the owner answers once the draft is handed over', async () => {
    const sw = await import('../src/app/api/social-accounts/[id]/route');
    const verify = await import('../src/app/api/social-accounts/[id]/verification/route');
    const schema = await sch();
    const { eq } = await drizzle();
    const acct = (await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.externalId, 'acc1') }))!;
    signIn(owner);
    expect((await call(sw.PATCH, 'PATCH', `/api/social-accounts/${acct.id}`, { id: acct.id }, { draftsEnabled: true })).status).toBe(409);
    const postId = randomUUID();
    const targetId = randomUUID();
    await (await db()).insert(schema.publishPosts).values({ id: postId, projectId: ids.project, editVersionId: ids.v1, createdBy: owner.id, mode: 'now', status: 'in_progress', approvedAt: new Date(), approvedBy: owner.id });
    await (await db()).insert(schema.publishTargets).values({ id: targetId, postId, platform: 'tiktok', accountId: acct.id, idempotencyKey: `pt_${targetId}`, method: 'zernio', delivery: 'draft', isVerification: true, status: 'manual_step_required', manualStep: 'finish_in_tiktok_app', submittedAt: new Date(), externalPostId: 'zp1' });
    const posts = await import('../src/app/api/publish-posts/[id]/route');
    const dto = await call(posts.GET, 'GET', `/api/publish-posts/${postId}`, { id: postId });
    expect(dto.json.targets[0].awaitingVerificationAnswer).toBe(true);
    expect((await call(verify.POST, 'POST', `/api/social-accounts/${acct.id}/verification`, { id: acct.id }, { result: 'seen', targetId })).status).toBe(200);
    const after = (await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, acct.id) }))!;
    expect(after.capabilities['verifiedDraftAt']).toBeTruthy();
    expect(after.capabilities['verifiedDirectAt']).toBeFalsy();
    const on = await call(sw.PATCH, 'PATCH', `/api/social-accounts/${acct.id}`, { id: acct.id }, { draftsEnabled: true });
    expect(on.status).toBe(200);
    const eligibility = await import('../src/app/api/publishing/eligibility/route');
    const res = await call(eligibility.GET, 'GET', `/api/publishing/eligibility?versions=${ids.v1}`);
    expect(res.json.items[0].methods.tiktok[1]).toMatchObject({ method: 'zernio', delivery: 'draft', available: true, isVerification: false });
  });

  it('webhooks: a signed delivery is stored once under its event id; a badly signed one under unverified:; only an envelope is kept', async () => {
    const r = await import('../src/app/api/webhooks/zernio/route');
    const schema = await sch();
    const { eq, and } = await drizzle();
    const body = JSON.stringify({ id: 'evt_123', event: 'post.platform.published', timestamp: '2026-11-15T00:00:00Z', post: { id: 'zp9', content: 'A caption that is not stored', metadata: { studioTargetId: 't-1' } }, platform: { name: 'tiktok', publishedUrl: 'https://www.tiktok.com/@x/video/1' }, account: { accountId: 'acc1' } });
    const sig = createHmac('sha256', SECRET).update(body).digest('hex');
    const headers = { 'content-type': 'application/json', 'x-zernio-signature': sig, 'x-zernio-event-id': 'evt_123' };
    const first = await call(r.POST, 'POST', '/api/webhooks/zernio', {}, undefined, headers, body);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ ok: true, duplicate: false });
    const again = await call(r.POST, 'POST', '/api/webhooks/zernio', {}, undefined, headers, body);
    expect(again.json).toEqual({ ok: true, duplicate: true });
    const rows = await (await db()).query.webhookEvents.findMany({ where: eq(schema.webhookEvents.provider, 'zernio') });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalEventId: 'evt_123', eventType: 'post.platform.published', signatureValid: true });
    expect(rows[0]?.payload).toEqual({ id: 'evt_123', event: 'post.platform.published', postId: 'zp9', studioTargetId: 't-1', platform: 'tiktok', accountId: 'acc1' });
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('caption');
    const jobs = await (await db()).query.jobs.findMany({ where: and(eq(schema.jobs.type, 'webhook.process'), eq(schema.jobs.refId, rows[0]!.id)) });
    expect(jobs).toHaveLength(1);
    // The same event id with a wrong signature cannot take (or block) the real event's slot.
    const forged = await call(r.POST, 'POST', '/api/webhooks/zernio', {}, undefined, { ...headers, 'x-zernio-signature': 'f'.repeat(64) }, body.replace('zp9', 'zp-forged'));
    expect(forged.status).toBe(200);
    const unverified = await (await db()).query.webhookEvents.findMany({ where: and(eq(schema.webhookEvents.provider, 'zernio'), eq(schema.webhookEvents.signatureValid, false)) });
    expect(unverified).toHaveLength(1);
    expect(unverified[0]?.externalEventId).toBe(`unverified:${createHash('sha256').update(body.replace('zp9', 'zp-forged')).digest('hex')}`);
    expect((await call(r.POST, 'POST', '/api/webhooks/zernio', {}, undefined, { 'content-type': 'application/json' }, 'not json')).status).toBe(400);
    process.env.TIKTOK_PUBLISH_PROVIDER = 'none';
    expect((await call(r.POST, 'POST', '/api/webhooks/zernio', {}, undefined, headers, body)).status).toBe(404);
    process.env.TIKTOK_PUBLISH_PROVIDER = 'zernio';
  });

  it('disconnect forgets the key, switches the account off, moves unsent Zernio posts to "reconnect" and deletes stored deliveries', async () => {
    const r = await import('../src/app/api/integrations/zernio/route');
    const schema = await sch();
    const { eq } = await drizzle();
    const acct = (await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.externalId, 'acc1') }))!;
    const postId = randomUUID();
    const targetId = randomUUID();
    await (await db()).insert(schema.publishPosts).values({ id: postId, projectId: ids.project, editVersionId: ids.v1, createdBy: owner.id, mode: 'now', status: 'approved', approvedAt: new Date(), approvedBy: owner.id });
    await (await db()).insert(schema.publishTargets).values({ id: targetId, postId, platform: 'tiktok', accountId: acct.id, idempotencyKey: `pt_${targetId}`, method: 'zernio', status: 'queued' });
    signIn(staff);
    expect((await call(r.DELETE, 'DELETE', '/api/integrations/zernio')).status).toBe(403);
    signIn(owner);
    const res = await call(r.DELETE, 'DELETE', '/api/integrations/zernio');
    // This one and the post approved earlier in this file, both still unsent.
    expect(res.json).toEqual({ disconnected: true, targetsMoved: 2 });
    const conn = (await (await db()).query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'zernio') }))!;
    expect(conn).toMatchObject({ status: 'disconnected', accessTokenEncrypted: null });
    expect(conn.config['keyHint']).toBeUndefined();
    expect((await (await db()).query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, acct.id) }))).toMatchObject({ status: 'disconnected', directPublishEnabled: false });
    expect((await (await db()).query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, targetId) }))).toMatchObject({ status: 'manual_step_required', manualStep: 'reconnect_account' });
    expect(await (await db()).query.webhookEvents.findMany({ where: eq(schema.webhookEvents.provider, 'zernio') })).toHaveLength(0);
    const got = await call(r.GET, 'GET', '/api/integrations/zernio');
    expect(got.json).toMatchObject({ connectionStatus: 'disconnected', keyHint: null, account: null, candidates: [] });
    const eligibility = await import('../src/app/api/publishing/eligibility/route');
    const after = await call(eligibility.GET, 'GET', `/api/publishing/eligibility?versions=${ids.v1}`);
    expect(after.json.items[0].methods.tiktok.map((o: { method: string }) => o.method)).toEqual(['manual']);
  });
});
