import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { REFERENCE_STYLE_ANALYSIS_VERSION, STILL_IN_USE_LINE, assembleReferenceSignals, profileReference, type EditPlan, type RawJoin, type ReferenceStyleProfile } from '@studio/core';
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

  it('offers "Your style from your videos" and applies decisions through the settings lock', async () => {
    // Two measured SYNTHETIC references with the same style (as the worker stores them): straight cuts with a white
    // flash every 4th beat, cuts on every second beat at 120 BPM.
    const beats = Array.from({ length: 33 }, (_, i) => i * 0.5);
    const joins: RawJoin[] = Array.from({ length: 15 }, (_, i) => (i % 2 === 1 ? { kind: 'fade_white', timeSec: i + 1, durationSec: 0.2 } : { kind: 'hard', timeSec: i + 1, durationSec: 0 }));
    const style = assembleReferenceSignals({
      fps: 30,
      measuredSec: 16,
      endScreenTrimmedSec: 0,
      joins,
      zoomShots: { checked: 16, pushScales: [], pullScales: [] },
      audio: { bpm: 120, confidence: 0.9, beatTimesSec: beats, energy: Array.from({ length: 64 }, (_, i) => (i % 2 ? 0.2 : 1)), energyStepSec: 0.25, speechLikely: false },
    });
    const refIds = [randomUUID(), randomUUID()];
    for (const [i, id] of refIds.entries()) {
      const profile = profileReference(
        { assetId: id, sourceFilename: `synthetic-r2-${i}.mp4`, durationSec: 16, shotDurationsSec: [], look: { meanLuma: 0.5, meanSaturation: 0.4, contrast: 0.3 }, text: null, measuredAt: new Date(Date.now() + i * 1000), style },
        { defaultDurationSec: 30, pacing: 'balanced', colour: 'natural', textDensity: 'light' },
      );
      await db.insert(schema.mediaAssets).values({ id, projectId: ids.project, kind: 'reference_video', originalFilename: `synthetic-r2-${i}.mp4`, mimeType: 'video/mp4', byteSize: 1, originalKey: `projects/${ids.project}/assets/${id}/original.mp4`, status: 'ready', referenceProfile: { ...profile, originalsDeletedAt: new Date().toISOString() } });
    }
    const summaryRoute = await import('../src/app/api/references/summary/route');
    const decideRoute = await import('../src/app/api/references/summary/decide/route');
    const resetRoute = await import('../src/app/api/references/summary/reset/route');

    as(staff);
    const read = await call(summaryRoute.GET, 'GET', '/api/references/summary', {});
    expect(read.status).toBe(200);
    // Staff see the rows read-only but not the owner's files.
    expect(read.json.list).toEqual([]);
    expect(read.json.summary.referenceAssetIds).toEqual([]);
    expect(read.json.suggestions.length).toBe(9);
    expect((await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['beatSync'] })).status).toBe(403);
    expect((await call(resetRoute.POST, 'POST', '/api/references/summary/reset', {}, {})).status).toBe(403);

    as(owner);
    const got = await call(summaryRoute.GET, 'GET', '/api/references/summary', {});
    expect(got.json.videos).toMatchObject({ total: 3, measured: 2, olderMeasurement: 1, measuring: 0, failed: 0 });
    expect(got.json.list.find((v: { olderMeasurement: boolean }) => v.olderMeasurement)).toBeDefined();
    const rows = new Map<string, any>(got.json.suggestions.map((r: { field: string }) => [r.field, r]));
    const palette = rows.get('transitionPalette');
    expect(palette.state).toBe('open');
    expect(palette.evidence).toMatchObject({ measured: 2, agreeing: 2, total: 3 });
    expect(palette.value).toMatchObject({ hardCutShare: 1, accent: { type: 'fadewhite', everyBeats: 4 } });
    const beat = rows.get('beatSync');
    expect(beat.state).toBe('open');
    expect(beat.alsoChanges).toEqual([{ field: 'beatsPerCut', value: 2 }]);

    // CSRF guard, a stale valueKey (409, nothing written) and a row without a suggestion (400).
    expect((await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['beatSync'], valueKeys: { beatSync: beat.valueKey } }, {})).status).toBe(403);
    const stale = await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['beatSync'], valueKeys: { beatSync: 'old' } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.message).toBe('Your style summary changed — check the new suggestion.');
    expect((await settingsRow()).preferences.editingStyle.beatSync).toBe('auto');
    expect((await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['zoom'], valueKeys: { zoom: 'x' } })).status).toBe(rows.get('zoom').value === null ? 400 : 409);

    const ok = await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['transitionPalette', 'beatSync'], dismiss: ['musicFit'], valueKeys: { transitionPalette: palette.valueKey, beatSync: beat.valueKey, musicFit: rows.get('musicFit').valueKey } });
    expect(ok.status).toBe(200);
    const saved = (await settingsRow()).preferences.editingStyle;
    expect(saved.transitionPalette).toEqual(palette.value);
    expect(saved.beatSync).toBe('on');
    expect(saved.beatsPerCut).toBe(2);
    expect(saved.sources.transitionPalette).toMatchObject({ by: 'reference', referenceName: 'Your videos (3)' });
    expect(saved.sources.transitionPalette?.referenceAssetIds).toEqual(expect.arrayContaining(refIds));
    expect(saved.summaryDecisions).toMatchObject({ transitionPalette: { decision: 'accepted', valueKey: palette.valueKey }, musicFit: { decision: 'dismissed' } });
    expect(ok.json.summary.suggestions.find((r: { field: string }) => r.field === 'transitionPalette')).toMatchObject({ state: 'accepted', inUse: true });
    const audits = (await db.query.auditLog.findMany()).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(['reference.summary_decided', 'preferences.editing_style_changed']));

    // Settings can change the values (the source becomes the owner) but never the bookkeeping.
    const settingsRoute = await import('../src/app/api/settings/route');
    expect((await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { sources: {} } } })).status).toBe(400);
    expect((await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { summaryDecisions: {} } } })).status).toBe(400);
    expect((await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { beatSync: 'sometimes' } } })).status).toBe(400);
    const changed = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { beatSync: 'off' } } });
    expect(changed.status).toBe(200);
    const after = (await settingsRow()).preferences.editingStyle;
    expect(after.beatSync).toBe('off');
    expect(after.sources.beatSync?.by).toBe('owner');
    expect(after.transitionPalette).toEqual(palette.value);
    expect(after.summaryDecisions.transitionPalette?.decision).toBe('accepted');

    // "Go back to each style's own" keeps length, pace, colour and text.
    const before = (await settingsRow()).preferences;
    const reset = await call(resetRoute.POST, 'POST', '/api/references/summary/reset', {}, {});
    expect(reset.status).toBe(200);
    const back = (await settingsRow()).preferences;
    expect(back.editingStyle.transitionPalette).toBeNull();
    expect(back.editingStyle.beatSync).toBe('auto');
    expect(back.pacing).toBe(before.pacing);
    expect(back.defaultDurationSec).toBe(before.defaultDurationSec);
  });

  it('lists a video measured with another version of the measuring but leaves it out of "your style"', async () => {
    as(owner);
    const summaryRoute = await import('../src/app/api/references/summary/route');
    const before = await call(summaryRoute.GET, 'GET', '/api/references/summary', {});
    expect(before.json.summary.olderVersion).toBe(0);
    // A SYNTHETIC reference with cross-fades, stored as a different measuring version would store it (after tuning).
    const style = assembleReferenceSignals({
      fps: 30,
      measuredSec: 16,
      endScreenTrimmedSec: 0,
      joins: Array.from({ length: 6 }, (_, i): RawJoin => ({ kind: 'cross_fade', timeSec: 2 * i + 2, durationSec: 0.5 })),
      zoomShots: { checked: 16, pushScales: [], pullScales: [] },
      audio: { bpm: 96, confidence: 0.9, beatTimesSec: Array.from({ length: 26 }, (_, i) => i * 0.625), energy: Array.from({ length: 64 }, () => 0.5), energyStepSec: 0.25, speechLikely: false },
    });
    const id = randomUUID();
    const profile = profileReference(
      { assetId: id, sourceFilename: 'synthetic-other-version.mp4', durationSec: 16, shotDurationsSec: [], look: { meanLuma: 0.5, meanSaturation: 0.4, contrast: 0.3 }, text: null, measuredAt: new Date(Date.now() + 60_000), style: { ...style, analysisVersion: REFERENCE_STYLE_ANALYSIS_VERSION + 1 } },
      { defaultDurationSec: 30, pacing: 'balanced', colour: 'natural', textDensity: 'light' },
    );
    await db.insert(schema.mediaAssets).values({ id, projectId: ids.project, kind: 'reference_video', originalFilename: 'synthetic-other-version.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: `projects/${ids.project}/assets/${id}/original.mp4`, status: 'ready', referenceProfile: { ...profile, originalsDeletedAt: new Date().toISOString() } });

    const after = await call(summaryRoute.GET, 'GET', '/api/references/summary', {});
    expect(after.status).toBe(200);
    expect(after.json.summary).toMatchObject({ total: before.json.summary.total, measured: before.json.summary.measured, olderVersion: 1 });
    expect(after.json.videos).toMatchObject({ measured: before.json.videos.measured, olderVersion: 1 });
    expect(after.json.summary.referenceAssetIds).not.toContain(id);
    expect(after.json.list.find((v: { id: string }) => v.id === id)).toMatchObject({ olderVersion: true, olderMeasurement: false });
    // The rows are exactly what they were without it.
    const rows = (r: { json: { suggestions: Array<{ field: string; valueKey: string | null; evidence: unknown; state: string }> } }) => r.json.suggestions.map((x) => [x.field, x.valueKey, x.evidence, x.state]);
    expect(rows(after)).toEqual(rows(before));

    // Its own suggestions (its pace, length and colour came from that measuring too) are not offered: refused, and
    // nothing is written.
    expect(profile.suggestions.length).toBeGreaterThan(0);
    const decideRoute = await import('../src/app/api/references/[assetId]/decide/route');
    const prefsBefore = (await settingsRow()).preferences;
    const refused = await call(decideRoute.POST, 'POST', `/api/references/${id}/decide`, { assetId: id }, { accept: [profile.suggestions[0]!.field] });
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toBe('This video was measured with an older version of the measuring, so its suggestions are not offered. Upload it again to get new ones.');
    expect((await settingsRow()).preferences).toEqual(prefsBefore);
    const stored = await db.query.mediaAssets.findFirst({ where: (t, { eq }) => eq(t.id, id) });
    expect((stored?.referenceProfile as ReferenceStyleProfile).decisions).toEqual({});

    // Uploading the same video again adds a new, current copy and keeps the old one, which is still listed and counted:
    // the wording therefore says to remove the old copy, and removing it clears the count.
    const againId = randomUUID();
    const again = profileReference(
      { assetId: againId, sourceFilename: 'synthetic-other-version.mp4', durationSec: 16, shotDurationsSec: [], look: { meanLuma: 0.5, meanSaturation: 0.4, contrast: 0.3 }, text: null, measuredAt: new Date(Date.now() + 120_000), style },
      { defaultDurationSec: 30, pacing: 'balanced', colour: 'natural', textDensity: 'light' },
    );
    await db.insert(schema.mediaAssets).values({ id: againId, projectId: ids.project, kind: 'reference_video', originalFilename: 'synthetic-other-version.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: `projects/${ids.project}/assets/${againId}/original.mp4`, status: 'ready', referenceProfile: { ...again, originalsDeletedAt: new Date().toISOString() } });
    const { eq } = await import('drizzle-orm');
    try {
      const uploadedAgain = await call(summaryRoute.GET, 'GET', '/api/references/summary', {});
      expect(uploadedAgain.json.summary).toMatchObject({ total: before.json.summary.total + 1, olderVersion: 1 });
      expect(uploadedAgain.json.summary.referenceAssetIds).toContain(againId);
      const copies = uploadedAgain.json.list.filter((v: { filename: string }) => v.filename === 'synthetic-other-version.mp4');
      expect(copies.map((v: { id: string; olderVersion: boolean }) => [v.id, v.olderVersion])).toEqual([
        [againId, false],
        [id, true],
      ]);
      // "Remove" on the old copy (as on its Studio reference card) leaves nothing measured with an older version.
      const removeRoute = await import('../src/app/api/assets/[id]/route');
      expect((await call(removeRoute.DELETE, 'DELETE', `/api/assets/${id}`, { id })).status).toBe(200);
      expect((await call(summaryRoute.GET, 'GET', '/api/references/summary', {})).json.summary.olderVersion).toBe(0);
    } finally {
      // The later tests expect only the two current videos with flashes.
      await db.update(schema.mediaAssets).set({ deletedAt: new Date() }).where(eq(schema.mediaAssets.id, againId));
    }
  });

  it('keeps a style accepted from the videos in use, and stoppable, when no current video backs it any more', async () => {
    as(owner);
    const { eq } = await import('drizzle-orm');
    const summaryRoute = await import('../src/app/api/references/summary/route');
    const decideRoute = await import('../src/app/api/references/summary/decide/route');
    const settingsRoute = await import('../src/app/api/settings/route');
    type Row = { field: string; state: string; value: unknown; valueKey: string | null; seen: string; inUse: boolean };
    const palette = async () => ((await call(summaryRoute.GET, 'GET', '/api/references/summary', {})).json as { suggestions: Row[]; summary: Record<string, number> });
    const offered = (await palette()).suggestions.find((r) => r.field === 'transitionPalette')!;
    expect(offered.state).toBe('open');
    const accepted = await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['transitionPalette'], valueKeys: { transitionPalette: offered.valueKey } });
    expect(accepted.status).toBe(200);

    // The measuring version is raised (simulated on the stored profiles): no video of the current version is left.
    const current = (await db.query.mediaAssets.findMany({ where: (t, { and: all, eq: is, isNull }) => all(is(t.kind, 'reference_video'), isNull(t.deletedAt)) })).filter(
      (a) => (a.referenceProfile as { style?: { analysisVersion?: number } | null } | null)?.style?.analysisVersion === REFERENCE_STYLE_ANALYSIS_VERSION,
    );
    expect(current.length).toBe(2);
    const withVersion = (profile: unknown, analysisVersion: number) => {
      const p = profile as { style: Record<string, unknown> };
      return { ...p, style: { ...p.style, analysisVersion } } as never;
    };
    for (const a of current) await db.update(schema.mediaAssets).set({ referenceProfile: withVersion(a.referenceProfile, REFERENCE_STYLE_ANALYSIS_VERSION + 1) }).where(eq(schema.mediaAssets.id, a.id));
    try {
      const bumped = await palette();
      // The two moved here (the copy from another version was removed in the test before).
      expect(bumped.summary).toMatchObject({ measured: 0, olderVersion: 2 });
      // The planners still use the cross-fades accepted earlier, so the row says so and can stop them.
      const row = bumped.suggestions.find((r) => r.field === 'transitionPalette')!;
      expect(row).toMatchObject({ state: 'not_measured', value: null, inUse: true });
      expect(row.seen.endsWith(STILL_IN_USE_LINE)).toBe(true);
      expect((await settingsRow()).preferences.editingStyle.transitionPalette).toEqual(offered.value);
      const stopped = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { transitionPalette: null } } });
      expect(stopped.status).toBe(200);
      expect((await palette()).suggestions.find((r) => r.field === 'transitionPalette')).toMatchObject({ state: 'not_measured', inUse: false });
    } finally {
      for (const a of current) await db.update(schema.mediaAssets).set({ referenceProfile: withVersion(a.referenceProfile, REFERENCE_STYLE_ANALYSIS_VERSION) }).where(eq(schema.mediaAssets.id, a.id));
    }
  });

  it('refuses a music tempo range the wrong way round at PUT /api/settings and keeps the stored one', async () => {
    as(owner);
    const settingsRoute = await import('../src/app/api/settings/route');
    const fit = (bpmLow: number, bpmHigh: number) => ({ bpmLow, bpmHigh, prefersClearDrop: true, dynamicRangeDb: 8 });
    const ordered = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { musicFit: fit(110, 130) } } });
    expect(ordered.status).toBe(200);
    expect((await settingsRow()).preferences.editingStyle.musicFit).toEqual(fit(110, 130));
    const single = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { musicFit: fit(124, 124) } } });
    expect(single.status).toBe(200);
    expect((await settingsRow()).preferences.editingStyle.musicFit).toEqual(fit(124, 124));
    const reversed = await call(settingsRoute.PUT, 'PUT', '/api/settings', {}, { preferences: { editingStyle: { musicFit: fit(130, 110) } } });
    expect(reversed.status).toBe(400);
    expect(reversed.json.error.details).toEqual([
      { path: 'preferences.editingStyle.musicFit.bpmLow', message: 'The music tempo range is the wrong way round: the lower BPM (bpmLow) must not be above the higher BPM (bpmHigh).' },
    ]);
    expect((await settingsRow()).preferences.editingStyle.musicFit).toEqual(fit(124, 124));
  });

  it('"Change: use each style\'s own" on "Cutting to the beat" also stops the beats per cut accepted with it', async () => {
    as(owner);
    const summaryRoute = await import('../src/app/api/references/summary/route');
    const decideRoute = await import('../src/app/api/references/summary/decide/route');
    const resetRoute = await import('../src/app/api/references/summary/reset/route');
    type Row = { field: string; state: string; value: unknown; valueKey: string | null; inUse: boolean; alsoChanges: Array<{ field: string; value: unknown }> };
    const rows = async () => new Map(((await call(summaryRoute.GET, 'GET', '/api/references/summary', {})).json.suggestions as Row[]).map((r) => [r.field, r]));
    const offered = await rows();
    const beat = offered.get('beatSync')!;
    const palette = offered.get('transitionPalette')!;
    expect(beat).toMatchObject({ state: 'open', alsoChanges: [{ field: 'beatsPerCut', value: 2 }] });
    const accepted = await call(decideRoute.POST, 'POST', '/api/references/summary/decide', {}, { accept: ['beatSync', 'transitionPalette'], valueKeys: { beatSync: beat.valueKey, transitionPalette: palette.valueKey } });
    expect(accepted.status).toBe(200);
    expect((await settingsRow()).preferences.editingStyle).toMatchObject({ beatSync: 'on', beatsPerCut: 2, sources: { beatSync: { by: 'reference' }, beatsPerCut: { by: 'reference' } } });

    // Owner only; a field that is not an editing-style row is refused, and nothing changes.
    as(staff);
    expect((await call(resetRoute.POST, 'POST', '/api/references/summary/reset', {}, { field: 'beatSync' })).status).toBe(403);
    as(owner);
    const before = (await settingsRow()).preferences;
    for (const field of ['pacing', 'beatsPerCut', 'nonsense']) expect((await call(resetRoute.POST, 'POST', '/api/references/summary/reset', {}, { field })).status, field).toBe(400);
    expect((await settingsRow()).preferences).toEqual(before);

    // What the card sends for the row: both values go back to the defaults, with their sources and the row's decision.
    const stopped = await call(resetRoute.POST, 'POST', '/api/references/summary/reset', {}, { field: 'beatSync' });
    expect(stopped.status).toBe(200);
    const style = (await settingsRow()).preferences.editingStyle;
    expect(style).toMatchObject({ beatSync: 'auto', beatsPerCut: null, transitionPalette: palette.value });
    expect(style.sources.beatSync).toBeUndefined();
    expect(style.sources.beatsPerCut).toBeUndefined();
    expect(style.summaryDecisions.beatSync).toBeUndefined();
    // The transitions accepted with it stay in use and stoppable; the beat row offers the beat again, nothing in use.
    expect(style.sources.transitionPalette).toMatchObject({ by: 'reference' });
    const after = await rows();
    expect(after.get('beatSync')).toMatchObject({ state: 'open', inUse: false });
    expect(after.get('transitionPalette')).toMatchObject({ state: 'accepted', inUse: true });
    expect((stopped.json.summary.suggestions as Row[]).find((r) => r.field === 'beatSync')).toMatchObject({ inUse: false });
    const audits = (await db.query.auditLog.findMany()).filter((a) => a.action === 'preferences.editing_style_changed').map((a) => a.data);
    expect(audits).toContainEqual({ reset: true, by: 'owner', row: 'beatSync', fields: ['beatSync', 'beatsPerCut'] });
  });
});
