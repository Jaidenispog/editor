import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MusicLicenceSchema, type EditPlan } from '@studio/core';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Music routes against a throwaway database (TEST_DATABASE_URL) with the real CSRF guard, validation and pg-boss
 * queue: the licence passport rules (CC BY-NC refused, Meta Sound Collection locked, owner-only licence changes),
 * private Spotify references and the embed switch, the export clearance gate and the music-free variant, Sound panel
 * revisions, and the version music summary. No external service is called. Skipped when TEST_DATABASE_URL is unset.
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
const SPOTIFY_ID = '4uLU6hMCjMI75M1A2tKUQC';
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

function planWithMusic(assetId: string, trackId: string | null): EditPlan {
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
    targetDurationSec: 10,
    segments: [seg('s1', 0, 5), seg('s2', 5, 10)],
    textOverlays: [],
    captions: [],
    audio: {
      music: trackId ? { trackId, startOffsetSec: 0, volume: 0.85, fadeInSec: 0.3, fadeOutSec: 1.2, duckUnderOriginal: true } : null,
      originalSound: { enabled: false, volume: 1 },
      beatAlignment: null,
      loudnessTargetLufs: -14,
    },
    colourPreset: 'clean',
  };
}

suite('Music routes (database-backed)', () => {
  const dbName = `sa_musictest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let storageRoot = '';
  let owner: TestUser;
  let staff: TestUser;
  const as = (u: TestUser) => {
    auth.session = { sessionId: `s-${u.id}`, user: u, expiresAt: new Date(Date.now() + 3600_000) };
  };
  const ids = { project: randomUUID(), asset: randomUUID(), track: randomUUID(), generation: randomUUID(), edit: randomUUID(), version: randomUUID() };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-music-storage-'));
    process.env.DATABASE_URL = url.toString();
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';

    const authLib = await import('../src/lib/auth');
    const o = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    owner = { id: o.id, email: o.email, displayName: o.displayName, role: 'owner' };
    staff = { id: randomUUID(), email: 'staff@example.com', displayName: 'Staff', role: 'staff' };
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const db = getDb();
    await db.insert(schema.users).values({ id: staff.id, email: staff.email, displayName: staff.displayName, passwordHash: 'x', role: 'staff' });
    await db.insert(schema.projects).values({ id: ids.project, ownerId: owner.id, title: 'Skin fade' });
    await db.insert(schema.mediaAssets).values({ id: ids.asset, projectId: ids.project, kind: 'video', originalFilename: 'a.mp4', mimeType: 'video/mp4', byteSize: 1, originalKey: `projects/${ids.project}/assets/${ids.asset}/original.mp4`, status: 'ready' });
    await db.insert(schema.musicTracks).values({
      id: ids.track,
      title: 'Licensed beat',
      storageKey: `music/${ids.track}/original.mp3`,
      mimeType: 'audio/mpeg',
      byteSize: 10,
      durationSec: 40,
      bpm: 120,
      status: 'ready',
      beats: { beatTimesSec: Array.from({ length: 80 }, (_, i) => i * 0.5), energy: [0.2, 0.5, 0.9, 0.4], energyStepSec: 10 },
      licence: MusicLicenceSchema.parse({ kind: 'catalogue', permitted: { promotionalUse: true, instagram: true }, confirmedByOwnerAt: null }),
    });
    await db.insert(schema.generations).values({
      id: ids.generation,
      projectId: ids.project,
      requestedBy: owner.id,
      settings: { durationSec: 10, styles: ['clean_promo'], musicTrackId: ids.track, keepOriginalSound: 'auto', captions: 'auto', instructions: '', musicStartSec: null },
    });
    await db.insert(schema.edits).values({ id: ids.edit, projectId: ids.project, generationId: ids.generation, styleId: 'clean_promo', slot: 0, currentVersionId: ids.version });
    await db.insert(schema.editVersions).values({ id: ids.version, editId: ids.edit, versionNo: 1, origin: 'initial', status: 'preview_ready', plan: planWithMusic(ids.asset, ids.track) });
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('refuses CC BY-NC tracks and CC BY tracks without a credit line at the API', async () => {
    as(owner);
    const route = await import('../src/app/api/music/route');
    const body = (licence: Record<string, unknown>) => ({ title: 'X', storageKey: 'music/x/original.mp3', mimeType: 'audio/mpeg', byteSize: 10, licence: { permitted: { promotionalUse: true }, ...licence } });
    const nc = await call(route.POST, 'POST', '/api/music', {}, body({ kind: 'cc_by_nc' }));
    expect(nc.status).toBe(400);
    expect(JSON.stringify(nc.json)).toMatch(/Non-commercial licences don't cover promoting a business/);
    const by = await call(route.POST, 'POST', '/api/music', {}, body({ kind: 'cc_by' }));
    expect(by.status).toBe(400);
    expect(JSON.stringify(by.json)).toMatch(/credit line/);
    const complete = await import('../src/app/api/uploads/[id]/complete/route');
    const viaUpload = await call(complete.POST, 'POST', '/api/uploads/u1/complete', { id: 'u1' }, { licence: { kind: 'cc_by_nc', permitted: {} }, confirmLicence: true });
    expect(viaUpload.status).toBe(400);
  });

  it('locks Meta Sound Collection licences and keeps licence changes to the owner', async () => {
    const route = await import('../src/app/api/music/[id]/route');
    as(staff);
    const denied = await call(route.PATCH, 'PATCH', `/api/music/${ids.track}`, { id: ids.track }, { confirmLicence: true });
    expect(denied.status).toBe(403);
    const tagged = await call(route.PATCH, 'PATCH', `/api/music/${ids.track}`, { id: ids.track }, { genres: ['hip hop'] });
    expect(tagged.status).toBe(200);
    expect(tagged.json.track.genres).toEqual(['hip hop']);
    expect((await call(route.DELETE, 'DELETE', `/api/music/${ids.track}`, { id: ids.track })).status).toBe(403);

    as(owner);
    const meta = await call(route.PATCH, 'PATCH', `/api/music/${ids.track}`, { id: ids.track }, { licence: { kind: 'meta_sound_collection', permitted: { promotionalUse: true, instagram: true, tiktok: true, website: true } } });
    expect(meta.status).toBe(200);
    expect(meta.json.track.licence).toMatchObject({ destinationLock: 'meta_only', permitted: { tiktok: false, website: false, instagram: true } });
    expect(meta.json.track.licenceState).toBe('not_confirmed');
    // Back to an unconfirmed library licence for the export tests below.
    const back = await call(route.PATCH, 'PATCH', `/api/music/${ids.track}`, { id: ids.track }, { licence: { kind: 'catalogue', permitted: { promotionalUse: true, instagram: true, tiktok: true } }, confirmLicence: false });
    expect(back.json.track.licence.destinationLock).toBeNull();
  });

  it('blocks the standard export of music that is not cleared, and still makes the music-free version once', async () => {
    as(owner);
    const route = await import('../src/app/api/edit-versions/[id]/export/route');
    const blocked = await call(route.POST, 'POST', `/api/edit-versions/${ids.version}/export`, { id: ids.version });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.message).toMatch(/isn't cleared for business use: The licence has not been confirmed by the owner\. Make a music-free version/);
    expect(blocked.json.error.details.musicClearance.state).toBe('blocked');

    const first = await call(route.POST, 'POST', `/api/edit-versions/${ids.version}/export?variant=no_music`, { id: ids.version });
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ variant: 'no_music', exportStatus: 'queued', musicClearance: { state: 'no_music' } });
    const again = await call(route.POST, 'POST', `/api/edit-versions/${ids.version}/export?variant=no_music`, { id: ids.version });
    expect(again.json.exportStatus).toBe('queued');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { and, eq } = await import('drizzle-orm');
    const jobs = await getDb().query.jobs.findMany({ where: and(eq(schema.jobs.refId, ids.version), eq(schema.jobs.type, 'render.export')) });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ variant: 'no_music' });
    const v = await getDb().query.editVersions.findFirst({ where: eq(schema.editVersions.id, ids.version) });
    expect(v?.exportStatus).toBe('none');
    expect(v?.variantExports.no_music?.status).toBe('queued');

    const download = await import('../src/app/api/edit-versions/[id]/download/route');
    expect((await call(download.GET, 'GET', `/api/edit-versions/${ids.version}/download?kind=export_no_music`, { id: ids.version })).status).toBe(409);

    const audit = await getDb().query.auditLog.findMany({ where: eq(schema.auditLog.action, 'music.export_blocked') });
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Once the owner confirms the licence the standard export is queued.
    await call((await import('../src/app/api/music/[id]/route')).PATCH, 'PATCH', `/api/music/${ids.track}`, { id: ids.track }, { confirmLicence: true });
    const ok = await call(route.POST, 'POST', `/api/edit-versions/${ids.version}/export`, { id: ids.version });
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ variant: 'standard', exportStatus: 'queued', musicClearance: { state: 'cleared', platforms: ['instagram', 'tiktok'] } });
  });

  it('summarises a version’s music for the card and the Sound panel', async () => {
    as(staff); // staff cannot open the owner's project
    const route = await import('../src/app/api/music/versions/[id]/route');
    expect((await call(route.GET, 'GET', `/api/music/versions/${ids.version}`, { id: ids.version })).status).toBe(404);
    as(owner);
    const res = await call(route.GET, 'GET', `/api/music/versions/${ids.version}`, { id: ids.version });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ versionId: ids.version, styleId: 'clean_promo', hasResultShot: false, clipsHaveSound: false, durationSec: 10 });
    expect(res.json.track).toMatchObject({ id: ids.track, licenceState: 'confirmed', bpm: 120 });
    expect(res.json.sound).toMatchObject({ hasMusic: true, volume: 0.85, originalSound: 'off' });
    expect(res.json.clearanceSummary).toBe('Music cleared for: Instagram and TikTok.');
    expect(res.json.noMusicExport.status).toBe('queued');
  });

  it('routes Sound panel changes: sound only keeps the cuts, a new track re-cuts', async () => {
    as(owner);
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const route = await import('../src/app/api/edits/[id]/revise/route');
    const empty = await call(route.POST, 'POST', `/api/edits/${ids.edit}/revise`, { id: ids.edit }, {});
    expect(empty.status).toBe(400);
    const sound = await call(route.POST, 'POST', `/api/edits/${ids.edit}/revise`, { id: ids.edit }, { audio: { volume: 0.4, fadeOutSec: 2 } });
    expect(sound.status).toBe(201);
    const job = await getDb().query.jobs.findFirst({ where: eq(schema.jobs.id, sound.json.jobId) });
    expect(job?.payload).toMatchObject({ mode: 'audio', audio: { volume: 0.4, fadeOutSec: 2 } });
    const feedback = await getDb().query.feedbackEvents.findMany({ where: eq(schema.feedbackEvents.editVersionId, sound.json.versionId) });
    expect(feedback[0]?.data).toMatchObject({ audioPatch: { volume: 0.4 } });

    // The new version must finish before the next change; mark it ready as the worker would.
    await getDb().update(schema.editVersions).set({ status: 'preview_ready' }).where(eq(schema.editVersions.id, sound.json.versionId));
    const missing = await call(route.POST, 'POST', `/api/edits/${ids.edit}/revise`, { id: ids.edit }, { audio: { trackId: 'not-a-track' } });
    expect(missing.status).toBe(400);
    const recut = await call(route.POST, 'POST', `/api/edits/${ids.edit}/revise`, { id: ids.edit }, { audio: { trackId: ids.track, revealOnBeat: 'on' } });
    expect(recut.status).toBe(201);
    const recutJob = await getDb().query.jobs.findFirst({ where: eq(schema.jobs.id, recut.json.jobId) });
    expect(recutJob?.payload).toMatchObject({ mode: 'revise', audio: { trackId: ids.track, revealOnBeat: 'on' } });
  });

  it('keeps private Spotify references: link-only by default, owner-only, lookalikes refused', async () => {
    const route = await import('../src/app/api/music/references/route');
    const modeRoute = await import('../src/app/api/music/references/mode/route');
    const itemRoute = await import('../src/app/api/music/references/[id]/route');
    as(staff);
    expect((await call(route.POST, 'POST', '/api/music/references', {}, { url: `https://open.spotify.com/track/${SPOTIFY_ID}` })).status).toBe(403);
    as(owner);
    // The CSRF guard refuses a request without the app's origin.
    expect((await call(route.POST, 'POST', '/api/music/references', {}, { url: `https://open.spotify.com/track/${SPOTIFY_ID}` }, {})).status).toBe(403);
    const fake = await call(route.POST, 'POST', '/api/music/references', {}, { url: `https://open.spotify.com.evil.com/track/${SPOTIFY_ID}` });
    expect(fake.status).toBe(400);
    expect(fake.json.error.message).toBe("That isn't a Spotify link.");
    const added = await call(route.POST, 'POST', '/api/music/references', {}, { url: `https://open.spotify.com/intl-de/track/${SPOTIFY_ID}?si=abc`, notes: 'vibe for fade videos' });
    expect(added.status).toBe(201);
    expect(added.json.reference).toMatchObject({ url: `https://open.spotify.com/track/${SPOTIFY_ID}`, itemType: 'track', notes: 'vibe for fade videos', embedUrl: null });
    expect((await call(route.POST, 'POST', '/api/music/references', {}, { url: `spotify:track:${SPOTIFY_ID}` })).status).toBe(409);

    const list = await call(route.GET, 'GET', '/api/music/references', {});
    expect(list.json).toMatchObject({ mode: 'link_only', canEmbed: false });
    expect(list.json.notice).toMatch(/kept for your own music reference only/);
    expect(list.json.missing.length).toBe(3);

    // The embed is refused until the terms and privacy pages exist and Spotify's terms are acknowledged.
    const refused = await call(modeRoute.PUT, 'PUT', '/api/music/references/mode', {}, { mode: 'embed', acknowledgeSpotifyTerms: true });
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toMatch(/terms of use page/);
    const settings = await import('../src/lib/settings');
    await settings.updateSettings({ business: { termsUrl: 'https://example.com/terms', privacyUrl: 'https://example.com/privacy' } }, owner.id);
    const on = await call(modeRoute.PUT, 'PUT', '/api/music/references/mode', {}, { mode: 'embed', acknowledgeSpotifyTerms: true });
    expect(on.status).toBe(200);
    expect(on.json.mode).toBe('embed');
    expect(on.json.references[0].embedUrl).toBe(`https://open.spotify.com/embed/track/${SPOTIFY_ID}`);
    const off = await call(modeRoute.PUT, 'PUT', '/api/music/references/mode', {}, { mode: 'link_only' });
    expect(off.json.mode).toBe('link_only');
    expect(off.json.references[0].embedUrl).toBeNull();

    const id = added.json.reference.id as string;
    expect((await call(itemRoute.PATCH, 'PATCH', `/api/music/references/${id}`, { id }, { notes: 'new' })).json.reference.notes).toBe('new');
    as(staff);
    expect((await call(itemRoute.DELETE, 'DELETE', `/api/music/references/${id}`, { id })).status).toBe(403);
    as(owner);
    expect((await call(itemRoute.DELETE, 'DELETE', `/api/music/references/${id}`, { id })).status).toBe(200);
  });

  it('suggests only usable tracks from the owner’s own library', async () => {
    as(owner);
    const route = await import('../src/app/api/music/suggestions/route');
    const res = await call(route.GET, 'GET', '/api/music/suggestions?durationSec=60', {});
    expect(res.status).toBe(200);
    expect(res.json.tracks[0]).toMatchObject({ id: ids.track, usable: false, rank: null });
    expect(res.json.tracks[0].unusableReason).toMatch(/Shorter than the edit/);
    expect((await call(route.GET, 'GET', '/api/music/suggestions?durationSec=500', {})).status).toBe(400);
  });
});
