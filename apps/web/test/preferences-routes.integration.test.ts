import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { profileReference, type EditPlan } from '@studio/core';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Saved preferences, "Hide this edit" and reference videos against a throwaway database (TEST_DATABASE_URL) with
 * the real CSRF guard, validation and pg-boss queue: owner-only routes, feedback with plan facts and the debounced
 * recompute job, pins from Settings and from reference suggestions, the learned subtree surviving owner saves, and
 * reference uploads that never become clips. No external service is called. Skipped when TEST_DATABASE_URL is unset.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

type TestUser = { id: string; email: string; displayName: string; role: 'owner' | 'staff' };
const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: { id: string; email: string; displayName: string; role: 'owner' | 'staff' }; expiresAt: Date } }));
vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, method: string, url: string, params: Record<string, string>, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }): Promise<{ status: number; json: any }> {
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function plan(assetId: string, durationSec = 20): EditPlan {
  const seg = (id: string, inSec: number, outSec: number) => ({
    id,
    assetId,
    inSec,
    outSec,
    speed: 1,
    framing: { mode: 'centre' as const, focusX: 0.5, focusY: 0.5 },
    zoom: null,
    transitionIn: null,
    role: 'cutting' as const,
    keepOriginalSound: false,
  });
  return {
    version: 1,
    styleId: 'clean_promo',
    title: 'Clean promo',
    description: 'Test plan',
    rationale: '',
    output: { width: 1080, height: 1920, fps: 30 },
    targetDurationSec: durationSec,
    segments: [seg('s1', 0, durationSec / 2), seg('s2', durationSec / 2, durationSec)],
    textOverlays: [],
    captions: [],
    audio: { music: null, originalSound: { enabled: false, volume: 1 }, beatAlignment: null, loudnessTargetLufs: -14 },
    colourPreset: 'clean',
  };
}

suite('Preferences, hidden edits and reference videos (database-backed)', () => {
  const dbName = `sa_prefstest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let storageRoot = '';
  let owner: TestUser;
  let staff: TestUser;
  const as = (u: TestUser) => {
    auth.session = { sessionId: `s-${u.id}`, user: u, expiresAt: new Date(Date.now() + 3600_000) };
  };
  const ids = { project: randomUUID(), asset: randomUUID(), reference: randomUUID(), generation: randomUUID(), edit: randomUUID(), version: randomUUID() };
  let db: Awaited<ReturnType<typeof import('../src/lib/db')['getDb']>>;
  let schema: typeof import('@studio/db')['schema'];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-prefs-storage-'));
    process.env.DATABASE_URL = url.toString();
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';

    const authLib = await import('../src/lib/auth');
    const o = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    owner = { id: o.id, email: o.email, displayName: o.displayName, role: 'owner' };
    staff = { id: randomUUID(), email: 'staff@example.com', displayName: 'Staff', role: 'staff' };
    db = (await import('../src/lib/db')).getDb();
    schema = (await import('@studio/db')).schema;
    await db.insert(schema.users).values({ id: staff.id, email: staff.email, displayName: staff.displayName, passwordHash: 'x', role: 'staff' });
    await db.insert(schema.projects).values({ id: ids.project, ownerId: owner.id, title: 'Skin fade', clientName: 'Jordan', status: 'complete' });
    await db.insert(schema.mediaAssets).values({ id: ids.asset, projectId: ids.project, kind: 'video', originalFilename: 'a.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: `projects/${ids.project}/assets/${ids.asset}/original.mp4`, status: 'ready' });
    await db.insert(schema.generations).values({
      id: ids.generation,
      projectId: ids.project,
      requestedBy: owner.id,
      settings: { durationSec: 20, styles: ['clean_promo'], musicTrackId: null, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
    });
    await db.insert(schema.edits).values({ id: ids.edit, projectId: ids.project, generationId: ids.generation, styleId: 'clean_promo', slot: 0, currentVersionId: ids.version });
    await db.insert(schema.editVersions).values({ id: ids.version, editId: ids.edit, versionNo: 1, origin: 'initial', status: 'preview_ready', plan: plan(ids.asset) });
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  const settingsRow = async () => (await db.query.settings.findFirst({ where: (t, { eq }) => eq(t.id, 'default') }))!.data;

  it('keeps the preference controls to the owner and refuses requests without the site origin', async () => {
    as(staff);
    const view = await call((await import('../src/app/api/preferences/route')).GET, 'GET', '/api/preferences', {});
    expect(view.status).toBe(200);
    expect(view.json.canEdit).toBe(false);
    for (const [mod, url, body] of [
      ['../src/app/api/preferences/pin/route', '/api/preferences/pin', { field: 'pacing', pinned: true }],
      ['../src/app/api/preferences/learning/route', '/api/preferences/learning', { enabled: false }],
      ['../src/app/api/preferences/reset/route', '/api/preferences/reset', { confirm: true }],
      ['../src/app/api/preferences/recompute/route', '/api/preferences/recompute', {}],
    ] as const) {
      const route = await import(mod);
      expect((await call(route.POST, 'POST', url, {}, body)).status, url).toBe(403);
    }
    expect((await call((await import('../src/app/api/references/route')).GET, 'GET', '/api/references', {})).status).toBe(403);
    as(owner);
    const pin = await import('../src/app/api/preferences/pin/route');
    const noOrigin = await call(pin.POST, 'POST', '/api/preferences/pin', {}, { field: 'pacing', pinned: true }, {});
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.json.error.code).toBe('FORBIDDEN');
  });

  it('records favourites and hidden edits with plan facts and queues one debounced recompute', async () => {
    as(staff);
    const dismiss = await import('../src/app/api/edits/[id]/dismiss/route');
    // Staff cannot open the owner's project.
    expect((await call(dismiss.POST, 'POST', `/api/edits/${ids.edit}/dismiss`, { id: ids.edit }, { value: true })).status).toBe(404);
    as(owner);
    const fav = await import('../src/app/api/edits/[id]/favourite/route');
    expect((await call(fav.POST, 'POST', `/api/edits/${ids.edit}/favourite`, { id: ids.edit }, { value: true })).json).toEqual({ isFavourite: true });
    const hidden = await call(dismiss.POST, 'POST', `/api/edits/${ids.edit}/dismiss`, { id: ids.edit }, { value: true });
    expect(hidden.json).toEqual({ dismissed: true });
    const edit = await db.query.edits.findFirst({ where: (t, { eq }) => eq(t.id, ids.edit) });
    expect(edit?.dismissedAt).toBeInstanceOf(Date);
    const events = await db.query.feedbackEvents.findMany({ orderBy: (t, { asc }) => asc(t.createdAt) });
    expect(events.map((e) => e.type)).toEqual(['favourite', 'dismiss']);
    expect(events[0]!.data['planFacts']).toMatchObject({ styleId: 'clean_promo', durationSec: 20, segmentCount: 2 });
    expect(events[1]!.data).toMatchObject({ value: true, planFacts: { durationSec: 20 } });
    const jobs = await db.query.jobs.findMany({ where: (t, { eq }) => eq(t.type, 'preferences.recompute') });
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]!.refId).toBe('preferences');
    // The style affinity is no longer rewritten in the request.
    expect((await settingsRow()).preferences.styleAffinity).toEqual({});

    const statusLib = await import('../src/lib/studio-status');
    const project = (await db.query.projects.findFirst({ where: (t, { eq }) => eq(t.id, ids.project) }))!;
    const status = await statusLib.buildStudioStatus(project);
    expect(status.generations[0]!.edits[0]!.dismissed).toBe(true);
    const shown = await call(dismiss.POST, 'POST', `/api/edits/${ids.edit}/dismiss`, { id: ids.edit }, { value: false });
    expect(shown.json).toEqual({ dismissed: false });
    const recent = await call((await import('../src/app/api/preferences/route')).GET, 'GET', '/api/preferences', {});
    expect(recent.json.recent.map((r: { text: string }) => r.text)).toEqual(['Showed again Clean promo (Jordan, Skin fade)', 'Hid Clean promo (Jordan, Skin fade)', 'Favourited Clean promo (Jordan, Skin fade)']);
  });

  it('pins fields changed in Settings, refuses the learning subtree, and never overwrites what was learned', async () => {
    as(owner);
    const settingsRoute = await import('../src/app/api/settings/route');
    const refused = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { learned: { eventsConsidered: 5 } } });
    expect(refused.status).toBe(400);
    const spotify = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { music: { spotifyReferenceMode: 'embed' } });
    expect(spotify.status).toBe(400);
    expect(JSON.stringify(spotify.json)).toMatch(/references\/mode/);

    // The recompute job writes its subtree (as the worker does, with jsonb_set) ...
    const { sql } = await import('drizzle-orm');
    const learned = { computedAt: new Date().toISOString(), eventsConsidered: 3, since: null, error: null, fields: { pacing: { value: 'fast', weight: 9, counts: { favourites: 3, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 }, explanation: 'From 3 favourites.' } } };
    await db.update(schema.settings).set({ data: sql`jsonb_set(${schema.settings.data}, '{preferences,learned}', ${JSON.stringify(learned)}::jsonb, true)` as never });
    // ... and an owner save afterwards keeps it and pins what it changed.
    const saved = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { defaultDurationSec: 30 }, brand: { logoPlacement: 'corner' } });
    expect(saved.status).toBe(200);
    const data = await settingsRow();
    expect(data.preferences.learned.eventsConsidered).toBe(3);
    expect(data.preferences.defaultDurationSec).toBe(30);
    expect(data.preferences.learning.pinned.defaultDurationSec?.by).toBe('owner');
    expect(data.brand.logoPlacement).toBe('corner');
    const view = await call((await import('../src/app/api/preferences/route')).GET, 'GET', '/api/preferences', {});
    expect(view.json.effective.pacing).toBe('fast');
    expect(view.json.fields.find((f: { field: string }) => f.field === 'pacing').source).toBe('learned');

    // Pin the learned value, let it learn again, switch learning off, then reset.
    const pin = await import('../src/app/api/preferences/pin/route');
    expect((await call(pin.POST, 'POST', '/api/preferences/pin', {}, { field: 'pacing', pinned: true })).json.preferences.pacing).toBe('fast');
    expect((await settingsRow()).preferences.learning.pinned.pacing?.by).toBe('owner');
    expect((await call(pin.POST, 'POST', '/api/preferences/pin', {}, { field: 'pacing', pinned: true, value: 'warp' })).status).toBe(400);
    await call(pin.POST, 'POST', '/api/preferences/pin', {}, { field: 'pacing', pinned: false });
    expect((await settingsRow()).preferences.learning.pinned.pacing).toBeUndefined();
    const learning = await import('../src/app/api/preferences/learning/route');
    expect((await call(learning.POST, 'POST', '/api/preferences/learning', {}, { enabled: false })).json.preferences.learning.enabled).toBe(false);
    await call(learning.POST, 'POST', '/api/preferences/learning', {}, { enabled: true });
    const reset = await import('../src/app/api/preferences/reset/route');
    expect((await call(reset.POST, 'POST', '/api/preferences/reset', {}, {})).status).toBe(400);
    const done = await call(reset.POST, 'POST', '/api/preferences/reset', {}, { confirm: true });
    expect(done.status).toBe(200);
    const after = await settingsRow();
    expect(after.preferences.learned.fields).toEqual({});
    expect(after.preferences.learning.resetAt).not.toBeNull();
    expect(after.preferences.defaultDurationSec).toBe(30);
    const audits = await db.query.auditLog.findMany();
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['preferences.pinned', 'preferences.unpinned', 'preferences.learning_toggled', 'preferences.learning_reset', 'settings.logo_placement_changed']));
  });

  it('uploads a reference video that never becomes a clip, and pins the suggestions the owner accepts', async () => {
    as(owner);
    const uploads = await import('../src/app/api/references/uploads/route');
    expect((await call(uploads.POST, 'POST', '/api/references/uploads', {}, { filename: 'liked.mp4', size: 10, mimeType: 'video/mp4' })).status).toBe(400);
    const created = await call(uploads.POST, 'POST', `/api/references/uploads?projectId=${ids.project}&useVision=1`, {}, { filename: 'liked.mp4', size: 10, mimeType: 'video/mp4', kind: 'video' });
    expect(created.status).toBe(201);
    expect(created.json.kind).toBe('reference_video');
    const session = (await db.query.uploadSessions.findFirst({ where: (t, { eq }) => eq(t.id, created.json.uploadId) }))!;
    expect(session.kind).toBe('reference_video');
    expect(session.driverState['referenceOptions']).toEqual({ useVision: true });
    const part = await import('../src/app/api/uploads/[id]/parts/[n]/route');
    const partRes = await (part.PUT as unknown as Handler)(
      new NextRequest(`${ORIGIN}/api/uploads/${session.id}/parts/1`, { method: 'PUT', headers: { origin: ORIGIN, 'content-type': 'application/octet-stream' }, body: Buffer.from('0123456789') }),
      { params: Promise.resolve({ id: session.id, n: '1' }) },
    );
    expect(partRes.status).toBe(200);
    const complete = await import('../src/app/api/uploads/[id]/complete/route');
    const finished = await call(complete.POST, 'POST', `/api/uploads/${session.id}/complete`, { id: session.id }, {});
    expect(finished.status).toBe(200);
    expect(finished.json.kind).toBe('reference_video');
    const asset = (await db.query.mediaAssets.findFirst({ where: (t, { eq }) => eq(t.id, finished.json.assetId) }))!;
    expect(asset.kind).toBe('reference_video');
    const project = (await db.query.projects.findFirst({ where: (t, { eq }) => eq(t.id, ids.project) }))!;
    expect(project.status).toBe('complete');
    const ingest = await db.query.jobs.findMany({ where: (t, { eq }) => eq(t.type, 'ingest.asset') });
    expect(ingest.map((j) => j.payload['assetId'])).toContain(asset.id);
    expect((await db.query.auditLog.findMany()).map((a) => a.action)).toContain('reference.uploaded');

    // The worker measured it (stored profile as the worker writes it).
    const profile = profileReference(
      { assetId: asset.id, sourceFilename: 'liked.mp4', durationSec: 34, shotDurationsSec: [0.6, 0.7, 0.8, 0.9], look: { meanLuma: 0.6, meanSaturation: 0.2, contrast: 0.1 }, text: null, measuredAt: new Date() },
      { defaultDurationSec: 30, pacing: 'balanced', colour: 'natural', textDensity: 'light' },
    );
    await db.update(schema.mediaAssets).set({ status: 'ready', referenceProfile: { ...profile, originalsDeletedAt: new Date().toISOString() } }).where((await import('drizzle-orm')).eq(schema.mediaAssets.id, asset.id));

    const statusLib = await import('../src/lib/studio-status');
    const status = await statusLib.buildStudioStatus((await db.query.projects.findFirst({ where: (t, { eq }) => eq(t.id, ids.project) }))!);
    expect(status.assets.map((a) => a.id)).toEqual([ids.asset]);
    expect(status.references.map((r) => r.id)).toEqual([asset.id]);
    expect(status.references[0]!.profile?.suggestions.map((s) => s.field)).toEqual(['defaultDurationSec', 'pacing', 'colour']);

    const list = await call((await import('../src/app/api/references/route')).GET, 'GET', '/api/references', {});
    expect(list.json.references[0]).toMatchObject({ id: asset.id, projectId: ids.project, projectTitle: 'Skin fade' });

    const decide = await import('../src/app/api/references/[assetId]/decide/route');
    as(staff);
    expect((await call(decide.POST, 'POST', `/api/references/${asset.id}/decide`, { assetId: asset.id }, { accept: ['pacing'] })).status).toBe(403);
    as(owner);
    expect((await call(decide.POST, 'POST', `/api/references/${asset.id}/decide`, { assetId: asset.id }, { accept: ['textDensity'] })).status).toBe(400);
    const decided = await call(decide.POST, 'POST', `/api/references/${asset.id}/decide`, { assetId: asset.id }, { accept: ['pacing', 'defaultDurationSec'], dismiss: ['colour'] });
    expect(decided.status).toBe(200);
    expect(decided.json.profile.decisions).toEqual({ pacing: 'accepted', defaultDurationSec: 'accepted', colour: 'dismissed' });
    const prefs = (await settingsRow()).preferences;
    expect(prefs.pacing).toBe('fast');
    expect(prefs.defaultDurationSec).toBe(35);
    expect(prefs.learning.pinned.pacing).toMatchObject({ by: 'reference', referenceAssetId: asset.id, referenceName: 'liked.mp4' });
    expect(prefs.colour).toBe('natural');
  });
});
