import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Publishing routes against a throwaway database (TEST_DATABASE_URL): drafts, the music rule, Melbourne scheduling,
 * the duplicate rule, owner-only approval, manual confirmation with its feedback event and usage-ledger row (only once
 * published), cancel, reschedule, staff visibility, and the Instagram connect/callback with a local fake of Meta's
 * token exchange. The session lookup is replaced; CSRF, validation, the database and the pg-boss queue are real. No
 * real platform is called. Skipped when TEST_DATABASE_URL is unset.
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
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<{ status: number; json: any; res: Response }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
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
  return { status: res.status, json, res };
}

const signIn = (user: User) => {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
};

function plan(trackId: string | null) {
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
    audio: { music: trackId ? { trackId, startOffsetSec: 0, volume: 0.8, fadeInSec: 0, fadeOutSec: 1, duckUnderOriginal: true } : null, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'natural',
  };
}

suite('Publishing routes (database-backed)', () => {
  const dbName = `sa_pubtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let owner: User;
  let staff: User;
  let otherStaff: User;
  let fakeMeta: Server;
  const exchanged: string[] = [];
  const ids = { project: randomUUID(), staffProject: randomUUID(), edit: randomUUID(), v1: randomUUID(), v2: randomUUID(), vMeta: randomUUID(), vStaff: randomUUID(), track: randomUUID(), metaTrack: randomUUID() };

  beforeAll(async () => {
    fakeMeta = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://fake');
      exchanged.push(u.pathname + u.search);
      res.writeHead(u.searchParams.get('code') === 'good-code' ? 200 : 400, { 'content-type': 'application/json' });
      res.end(u.searchParams.get('code') === 'good-code' ? JSON.stringify({ access_token: 'system-user-token-from-fake', token_type: 'bearer' }) : JSON.stringify({ error: { message: 'Invalid verification code format.', code: 100 } }));
    });
    await new Promise<void>((r) => fakeMeta.listen(0, '127.0.0.1', r));
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
    process.env.META_APP_ID = 'fake-app';
    process.env.META_APP_SECRET = 'fake-secret';
    process.env.META_LOGIN_CONFIG_ID = 'fake-config-123';
    process.env.META_GRAPH_BASE_URL = `http://127.0.0.1:${(fakeMeta.address() as AddressInfo).port}`;
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { MusicLicenceSchema } = await import('@studio/core');
    const db = getDb();
    const mk = async (role: 'owner' | 'staff', name: string): Promise<User> => {
      const u = { id: randomUUID(), email: `${name.toLowerCase()}@example.com`, displayName: name, role };
      await db.insert(schema.users).values({ ...u, passwordHash: 'x' });
      return u;
    };
    owner = await mk('owner', 'Owner');
    staff = await mk('staff', 'Jordan');
    otherStaff = await mk('staff', 'Alex');
    await db.insert(schema.projects).values([
      { id: ids.project, ownerId: owner.id, title: 'Skin fade' },
      { id: ids.staffProject, ownerId: staff.id, title: 'Jordan cut' },
    ]);
    const licence = MusicLicenceSchema.parse({ kind: 'owner_upload', permitted: { promotionalUse: true, instagram: true, tiktok: true }, confirmedByOwnerAt: new Date().toISOString() });
    const meta = MusicLicenceSchema.parse({ kind: 'meta_sound_collection', permitted: { promotionalUse: true, instagram: true, facebook: true }, confirmedByOwnerAt: new Date().toISOString() });
    await db.insert(schema.musicTracks).values([
      { id: ids.track, title: 'Owned', storageKey: 'music/x/original.mp3', mimeType: 'audio/mpeg', byteSize: 1, licence },
      { id: ids.metaTrack, title: 'Meta', storageKey: 'music/y/original.mp3', mimeType: 'audio/mpeg', byteSize: 1, licence: meta },
    ]);
    const gen = randomUUID();
    const genStaff = randomUUID();
    const settings = { durationSec: 10, styles: ['clean_promo' as const], musicTrackId: null, keepOriginalSound: 'auto' as const, captions: 'auto' as const, instructions: '', musicStartSec: null };
    await db.insert(schema.generations).values([
      { id: gen, projectId: ids.project, requestedBy: owner.id, settings },
      { id: genStaff, projectId: ids.staffProject, requestedBy: staff.id, settings },
    ]);
    const editStaff = randomUUID();
    await db.insert(schema.edits).values([
      { id: ids.edit, projectId: ids.project, generationId: gen, styleId: 'clean_promo', slot: 0 },
      { id: editStaff, projectId: ids.staffProject, generationId: genStaff, styleId: 'clean_promo', slot: 0 },
    ]);
    await db.insert(schema.editVersions).values([
      { id: ids.v1, editId: ids.edit, versionNo: 1, origin: 'initial', status: 'preview_ready', plan: plan(ids.track) as never, previewKey: 'projects/p/edits/e/v1/preview.mp4' },
      { id: ids.v2, editId: ids.edit, versionNo: 2, origin: 'revise', status: 'preview_ready', plan: plan(null) as never },
      { id: ids.vMeta, editId: ids.edit, versionNo: 3, origin: 'revise', status: 'preview_ready', plan: plan(ids.metaTrack) as never },
      { id: ids.vStaff, editId: editStaff, versionNo: 1, origin: 'initial', status: 'preview_ready', plan: plan(null) as never },
    ]);
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    await new Promise<void>((r) => fakeMeta.close(() => r()));
  }, 60_000);

  const item = (over: Record<string, unknown> = {}) => ({ editVersionId: ids.v1, caption: 'Fresh skin fade #ivanhoe', coverTimeSec: 7, mode: 'now', targets: [{ platform: 'instagram', method: 'manual', variant: 'standard' }], ...over });

  it('shows eligibility with nothing preselected and only manual posting until Instagram is connected', async () => {
    const r = await import('../src/app/api/publishing/eligibility/route');
    signIn(owner);
    const res = await call(r.GET, 'GET', `/api/publishing/eligibility?versions=${ids.v1},${ids.vMeta}`);
    expect(res.status).toBe(200);
    const [a, m] = res.json.items;
    expect(a.methods.instagram).toEqual([{ method: 'manual', available: true, isVerification: false, handle: 'your Instagram account' }]);
    expect(a.methods.tiktok.map((o: { method: string }) => o.method)).toEqual(['manual']);
    expect(a.defaultCoverTimeSec).toBe(7.5);
    expect(m.eligibility.find((e: { platform: string }) => e.platform === 'tiktok').allowedVariants).toEqual(['no_music']);
    expect(m.eligibility.find((e: { platform: string }) => e.platform === 'instagram').downloadLabel).toBe('For Instagram/Facebook upload only');
    expect(res.json.canApprove).toBe(true);
  });

  it('creates drafts, refuses what the rules refuse, and caps a batch at five', async () => {
    const posts = await import('../src/app/api/publish-posts/route');
    signIn(owner);
    // Meta Sound Collection music never goes to TikTok with its music.
    const metaTikTok = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ editVersionId: ids.vMeta, targets: [{ platform: 'tiktok', method: 'manual', variant: 'standard' }] })] });
    expect(metaTikTok.status).toBe(400);
    expect(metaTikTok.json.error.message).toMatch(/Sound Collection/);
    // No direct publishing without a connected, verified account; no Zernio in Stage B.
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ targets: [{ platform: 'instagram', method: 'instagram_api', variant: 'standard' }] })] })).status).toBe(400);
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ targets: [{ platform: 'tiktok', method: 'zernio', variant: 'standard' }] })] })).status).toBe(422);
    // Melbourne time: the hour that does not exist, too soon, too far.
    const gap = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ mode: 'scheduled', schedule: { date: '2027-10-03', time: '02:30' } })] });
    expect(gap.status).toBe(400);
    expect(gap.json.error.message).toMatch(/doesn't exist/);
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ mode: 'scheduled', schedule: { date: '2020-01-01', time: '10:00' } })] })).status).toBe(400);
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: Array.from({ length: 6 }, () => item()) })).status).toBe(400);
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ caption: 'x'.repeat(2201) })] })).status).toBe(400);
    // A good one: the caption is stored as it will be posted, and the post is a draft.
    const ok = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ targets: [{ platform: 'instagram', method: 'manual', variant: 'standard' }, { platform: 'tiktok', method: 'manual', variant: 'no_music' }] })] });
    expect(ok.status).toBe(200);
    expect(ok.json.posts[0]).toMatchObject({ status: 'draft', caption: 'Fresh skin fade #ivanhoe', mode: 'now', approvedAt: null });
    expect(ok.json.posts[0].targets.map((t: { platform: string; variant: string; status: string }) => [t.platform, t.variant, t.status])).toEqual([
      ['instagram', 'standard', 'queued'],
      ['tiktok', 'no_music', 'queued'],
    ]);
  });

  it('lets only the owner approve; approval queues preparation and writes no feedback or ledger row', async () => {
    const posts = await import('../src/app/api/publish-posts/route');
    const approve = await import('../src/app/api/publish-posts/approve/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq, and } = await import('drizzle-orm');
    signIn(owner);
    const created = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ editVersionId: ids.v2 })] });
    const postId = created.json.posts[0].id;
    signIn(staff);
    expect((await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [postId] })).status).toBe(403);
    signIn(owner);
    const done = await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [postId] });
    expect(done.status).toBe(200);
    expect(done.json.posts[0].status).toBe('approved');
    expect((await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [postId] })).json.posts[0].status).toBe('approved');
    const jobs = await getDb().query.jobs.findMany({ where: and(eq(schema.jobs.type, 'publish.prepare'), eq(schema.jobs.refId, postId)) });
    expect(jobs).toHaveLength(1);
    const post = await getDb().query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, postId) });
    expect(post?.musicCheck).toMatchObject({ ok: true, licenceSnapshot: null });
    expect(await getDb().query.feedbackEvents.findMany({ where: eq(schema.feedbackEvents.type, 'publish') })).toHaveLength(0);
    expect(await getDb().query.musicUsage.findMany()).toHaveLength(0);
  });

  it('refuses a TikTok-via-Zernio target without the consent tick', async () => {
    const approve = await import('../src/app/api/publish-posts/approve/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const postId = randomUUID();
    const targetId = randomUUID();
    await getDb().insert(schema.publishPosts).values({ id: postId, projectId: ids.project, editVersionId: ids.v2, createdBy: owner.id, mode: 'now' });
    await getDb().insert(schema.publishTargets).values({ id: targetId, postId, platform: 'tiktok', idempotencyKey: `pt_${targetId}`, method: 'zernio', mediaVariant: 'standard' });
    signIn(owner);
    const res = await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [postId] });
    expect(res.status).toBe(400);
    expect(res.json.error.message).toMatch(/posted publicly to TikTok/);
  });

  it('confirms a manual post with a real link only, records feedback and the ledger once, and can undo', async () => {
    const posts = await import('../src/app/api/publish-posts/route');
    const approve = await import('../src/app/api/publish-posts/approve/route');
    const confirm = await import('../src/app/api/publish-targets/[id]/confirm-posted/route');
    const undo = await import('../src/app/api/publish-targets/[id]/undo-confirm/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq, and } = await import('drizzle-orm');
    signIn(owner);
    const created = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ targets: [{ platform: 'instagram', method: 'manual', variant: 'standard' }] })], allowRepeat: true });
    const post = created.json.posts[0];
    await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [post.id] });
    const targetId = post.targets[0].id;
    // Not the owner's turn yet (the worker prepares the file first).
    expect((await call(confirm.POST, 'POST', `/api/publish-targets/${targetId}/confirm-posted`, { id: targetId }, {})).status).toBe(409);
    await getDb().update(schema.publishTargets).set({ status: 'manual_step_required', manualStep: 'post_in_app', mediaKey: 'projects/p/x.mp4' }).where(eq(schema.publishTargets.id, targetId));
    expect((await call(confirm.POST, 'POST', `/api/publish-targets/${targetId}/confirm-posted`, { id: targetId }, { url: 'https://www.instagram.com.evil.example/reel/abcdef/' })).status).toBe(400);
    const ok = await call(confirm.POST, 'POST', `/api/publish-targets/${targetId}/confirm-posted`, { id: targetId }, { url: 'https://www.instagram.com/reel/Cabcdef123/?igsh=1' });
    expect(ok.status).toBe(200);
    expect(ok.json.targets[0]).toMatchObject({ status: 'published', publishedUrl: 'https://www.instagram.com/reel/Cabcdef123/', confirmedByName: 'Owner' });
    expect(ok.json.status).toBe('complete');
    const fb = await getDb().query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.type, 'publish'), eq(schema.feedbackEvents.editVersionId, ids.v1)) });
    expect(fb).toHaveLength(1);
    expect(fb[0]?.data).toMatchObject({ platform: 'instagram', method: 'manual', variant: 'standard' });
    const usage = await getDb().query.musicUsage.findMany({ where: eq(schema.musicUsage.editVersionId, ids.v1) });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ purpose: 'publish', platform: 'instagram', trackId: ids.track });
    // Undo goes back to "your turn"; confirming again adds no second feedback event or ledger row.
    const undone = await call(undo.POST, 'POST', `/api/publish-targets/${targetId}/undo-confirm`, { id: targetId }, {});
    expect(undone.json.targets[0]).toMatchObject({ status: 'manual_step_required', manualStep: 'post_in_app', publishedUrl: null });
    await call(confirm.POST, 'POST', `/api/publish-targets/${targetId}/confirm-posted`, { id: targetId }, {});
    expect(await getDb().query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.type, 'publish'), eq(schema.feedbackEvents.editVersionId, ids.v1)) })).toHaveLength(1);
    expect(await getDb().query.musicUsage.findMany({ where: eq(schema.musicUsage.editVersionId, ids.v1) })).toHaveLength(1);
    // The version now has a published Instagram target: posting it again needs "Post again".
    const repeat = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item()] });
    expect(repeat.status).toBe(409);
    expect(repeat.json.error.message).toMatch(/Post again/);
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item()], allowRepeat: true })).status).toBe(200);
  });

  it('reschedules without losing approval, returns to draft on a caption change, and cancels only what was not sent', async () => {
    const posts = await import('../src/app/api/publish-posts/route');
    const approve = await import('../src/app/api/publish-posts/approve/route');
    const one = await import('../src/app/api/publish-posts/[id]/route');
    const cancel = await import('../src/app/api/publish-posts/[id]/cancel/route');
    const { addDaysToDate, melbourneDateOf } = await import('@studio/core');
    signIn(owner);
    const date = addDaysToDate(melbourneDateOf(new Date()), 3);
    const created = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ editVersionId: ids.v2, mode: 'scheduled', schedule: { date, time: '10:00' } })], allowRepeat: true });
    expect(created.status).toBe(200);
    const post = created.json.posts[0];
    expect(post.scheduledForLabel).toMatch(/10:00 am (AEDT|AEST)$/);
    await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [post.id] });
    const moved = await call(one.PATCH, 'PATCH', `/api/publish-posts/${post.id}`, { id: post.id }, { schedule: { date, time: '11:30' } });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ status: 'approved' });
    expect(moved.json.scheduledForLabel).toMatch(/11:30 am/);
    const changed = await call(one.PATCH, 'PATCH', `/api/publish-posts/${post.id}`, { id: post.id }, { caption: 'New words' });
    expect(changed.json).toMatchObject({ status: 'draft', approvedAt: null, caption: 'New words' });
    expect((await call(cancel.POST, 'POST', `/api/publish-posts/${post.id}/cancel`, { id: post.id })).status).toBe(409);
    await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [post.id] });
    signIn(staff);
    expect((await call(cancel.POST, 'POST', `/api/publish-posts/${post.id}/cancel`, { id: post.id })).status).toBe(403);
    signIn(owner);
    const cancelled = await call(cancel.POST, 'POST', `/api/publish-posts/${post.id}/cancel`, { id: post.id });
    expect(cancelled.json).toMatchObject({ status: 'cancelled' });
    expect(cancelled.json.targets.every((t: { status: string }) => t.status === 'cancelled')).toBe(true);
  });

  it('shows staff only posts of their own projects, and lets them draft but not approve', async () => {
    const posts = await import('../src/app/api/publish-posts/route');
    signIn(staff);
    const mine = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ editVersionId: ids.vStaff })] });
    expect(mine.status).toBe(200);
    expect((await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ editVersionId: ids.v2 })], allowRepeat: true })).status).toBe(404);
    const list = await call(posts.GET, 'GET', '/api/publish-posts?view=queue');
    expect(list.json.posts.map((p: { id: string }) => p.id)).toEqual([mine.json.posts[0].id]);
    signIn(otherStaff);
    expect((await call(posts.GET, 'GET', '/api/publish-posts?view=queue')).json.posts).toEqual([]);
    signIn(owner);
    expect((await call(posts.GET, 'GET', '/api/publish-posts?view=queue')).json.posts.length).toBeGreaterThan(1);
  });

  it('connects Instagram through the Unified Login dialog (no scope), stores the token encrypted and only queues a read-only check', async () => {
    const connect = await import('../src/app/api/integrations/instagram/connect/route');
    const callback = await import('../src/app/api/integrations/instagram/callback/route');
    const check = await import('../src/app/api/integrations/[provider]/check/route');
    const meta = await import('../src/app/api/integrations/meta/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    signIn(staff);
    expect((await call(connect.GET, 'GET', '/api/integrations/instagram/connect')).status).toBe(403);
    signIn(owner);
    const started = await call(connect.GET, 'GET', '/api/integrations/instagram/connect');
    expect(started.status).toBe(302);
    const dialog = new URL(started.res.headers.get('location')!);
    expect(dialog.origin + dialog.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(Object.fromEntries(dialog.searchParams)).toMatchObject({ client_id: 'fake-app', config_id: 'fake-config-123', response_type: 'code', override_default_response_type: 'true', redirect_uri: `${ORIGIN}/api/integrations/instagram/callback` });
    expect(dialog.searchParams.has('scope')).toBe(false);
    const cookie = started.res.headers.get('set-cookie')!.split(';')[0]!;
    const state = dialog.searchParams.get('state')!;

    // A tampered state is refused and nothing is exchanged.
    const bad = await call(callback.GET, 'GET', `/api/integrations/instagram/callback?code=good-code&state=wrong`, {}, undefined, { origin: ORIGIN, cookie });
    expect(new URL(bad.res.headers.get('location')!).searchParams.get('instagram_error')).toMatch(/could not be confirmed/);
    expect(exchanged).toHaveLength(0);

    const ok = await call(callback.GET, 'GET', `/api/integrations/instagram/callback?code=good-code&state=${encodeURIComponent(state)}`, {}, undefined, { origin: ORIGIN, cookie });
    expect(ok.status).toBe(302);
    expect(new URL(ok.res.headers.get('location')!).searchParams.get('instagram')).toBe('checking');
    expect(exchanged).toHaveLength(1);
    expect(exchanged[0]).toMatch(/^\/v26\.0\/oauth\/access_token\?/);
    const conn = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
    expect(conn?.status).toBe('connected');
    expect(conn?.accessTokenEncrypted).toMatch(/^v1\./);
    expect(conn?.accessTokenEncrypted).not.toContain('system-user-token-from-fake');
    const jobs = await getDb().query.jobs.findMany({ where: eq(schema.jobs.type, 'social.check') });
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(jobs[0]?.payload)).not.toContain('system-user-token');
    const audit = await getDb().select().from(schema.auditLog).where(eq(schema.auditLog.action, 'integration.meta.connected'));
    expect(JSON.stringify(audit)).not.toContain('system-user-token');

    expect((await call(check.POST, 'POST', '/api/integrations/meta/check', { provider: 'meta' })).status).toBe(200);
    expect((await call(check.POST, 'POST', '/api/integrations/square/check', { provider: 'square' })).status).toBe(404);

    // A verified, switched-on account turns on direct publishing in the composer; disconnecting moves unsent targets.
    const accountId = randomUUID();
    await getDb().insert(schema.socialAccounts).values({ id: accountId, platform: 'instagram', externalId: '1784140000', username: 'ivanhoe_test', provider: 'meta_graph', connectionId: conn!.id, capabilities: {} });
    const eligibility = await import('../src/app/api/publishing/eligibility/route');
    let e = await call(eligibility.GET, 'GET', `/api/publishing/eligibility?versions=${ids.v2}`);
    expect(e.json.items[0].methods.instagram[0]).toMatchObject({ method: 'instagram_api', available: true, isVerification: true });
    const sw = await import('../src/app/api/social-accounts/[id]/route');
    expect((await call(sw.PATCH, 'PATCH', `/api/social-accounts/${accountId}`, { id: accountId }, { directPublishEnabled: true })).status).toBe(409);
    await getDb().update(schema.socialAccounts).set({ capabilities: { verifiedDirectAt: new Date().toISOString() } }).where(eq(schema.socialAccounts.id, accountId));
    expect((await call(sw.PATCH, 'PATCH', `/api/social-accounts/${accountId}`, { id: accountId }, { directPublishEnabled: true })).status).toBe(200);
    e = await call(eligibility.GET, 'GET', `/api/publishing/eligibility?versions=${ids.v2}`);
    expect(e.json.items[0].methods.instagram[0]).toMatchObject({ method: 'instagram_api', available: true, isVerification: false });
    const posts = await import('../src/app/api/publish-posts/route');
    const approve = await import('../src/app/api/publish-posts/approve/route');
    const created = await call(posts.POST, 'POST', '/api/publish-posts', {}, { items: [item({ editVersionId: ids.v2, targets: [{ platform: 'instagram', method: 'instagram_api', variant: 'standard' }] })], allowRepeat: true });
    expect(created.status).toBe(200);
    await call(approve.POST, 'POST', '/api/publish-posts/approve', {}, { postIds: [created.json.posts[0].id] });
    const gone = await call(meta.DELETE, 'DELETE', '/api/integrations/meta');
    expect(gone.json).toMatchObject({ disconnected: true, targetsMoved: 1 });
    const after = await getDb().query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.provider, 'meta') });
    expect(after).toMatchObject({ status: 'disconnected', accessTokenEncrypted: null });
    expect((await getDb().query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, accountId) }))).toMatchObject({ status: 'disconnected', directPublishEnabled: false });
  }, 60_000);
});
