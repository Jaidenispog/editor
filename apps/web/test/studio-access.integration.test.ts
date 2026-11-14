import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssetAnalysis, MusicLicence } from '@studio/core';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Route tests for who may see what (owner vs staff), clip ordering, per-shot tags, the Settings music
 * library (licence confirmation and uploads) and the music start point, against a throwaway database
 * (TEST_DATABASE_URL) and a temporary storage folder. The session lookup is replaced so each call runs as the
 * chosen user; everything else (CSRF guard, validation, database, storage, pg-boss queue) is real.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

type TestUser = { id: string; email: string; displayName: string; role: 'owner' | 'staff' };
const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: TestUser; expiresAt: Date } }));

vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));

const ORIGIN = 'http://localhost:3000';
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function as(user: TestUser): void {
  auth.session = { sessionId: `s-${user.id}`, user, expiresAt: new Date(Date.now() + 3600_000) };
}

async function call(handler: unknown, method: string, url: string, params: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  const init: { method: string; headers: Record<string, string>; body?: BodyInit } = { method, headers: { origin: ORIGIN } };
  if (body instanceof Uint8Array) {
    init.body = body as unknown as BodyInit;
    init.headers['content-type'] = 'application/octet-stream';
    init.headers['content-length'] = String(body.byteLength);
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await (handler as Handler)(new NextRequest(`${ORIGIN}${url}`, init), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function fakeAnalysis(assetId: string): AssetAnalysis {
  const quality = { sharpness: 0.7, brightness: 0.5, motion: 0.2, contrast: 0.4, exposureIssue: 'none' as const, score: 0.8 };
  const labels = ['before', 'cutting', 'fade_detail', 'result', 'reaction'] as const;
  return {
    version: 1,
    assetId,
    probe: {
      container: 'mp4',
      durationSec: 10,
      fileSizeBytes: 1,
      video: { codec: 'h264', codedWidth: 1080, codedHeight: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: null }, isHdr: false, hdrFormat: null, bitrate: null },
      audio: null,
    },
    shots: labels.map((label, i) => ({ id: `${assetId}-s${i}`, assetId, startSec: i * 2, endSec: i * 2 + 2, quality, label, labelSource: 'heuristic' as const, confidence: 0.6, description: '', framing: 'unknown' as const, focus: null, issues: [] })),
    sampledFrames: labels.map((_, i) => ({ timeSec: i * 2 + 1, storageKey: `projects/p/assets/${assetId}/frames/${i}.jpg`, width: 432, height: 768, shotId: `${assetId}-s${i}` })),
    audio: { hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 1, speechLikely: false, speechConfidence: 0 },
    transcript: null,
    labelling: { source: 'heuristic', model: null, note: '' },
    completedAt: new Date().toISOString(),
  };
}

const LICENCE: MusicLicence = {
  kind: 'commercial_licence',
  source: 'Music library',
  licenceName: 'Social licence',
  proofUrl: 'https://example.com/receipt',
  notes: '',
  permitted: { promotionalUse: true, instagram: true, tiktok: true, youtube: false, website: false },
  attributionRequired: false,
  attributionText: '',
  expiresAt: null,
  confirmedByOwnerAt: null,
};

suite('access rules, clip order, shot tags, music library and music start (database-backed)', () => {
  const dbName = `sa_accesstest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let storageRoot = '';
  let owner: TestUser;
  let staff: TestUser;
  let loner: TestUser;
  let ownerProjectId = '';
  let staffProjectId = '';
  const clipIds: string[] = [];
  let trackId = '';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-access-storage-'));
    process.env.DATABASE_URL = url.toString();
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';

    const authLib = await import('../src/lib/auth');
    const o = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    owner = { id: o.id, email: o.email, displayName: o.displayName, role: 'owner' };
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    staff = { id: randomUUID(), email: 'staff@example.com', displayName: 'Staff', role: 'staff' };
    loner = { id: randomUUID(), email: 'new@example.com', displayName: 'New starter', role: 'staff' };
    for (const u of [staff, loner]) await getDb().insert(schema.users).values({ id: u.id, email: u.email, displayName: u.displayName, passwordHash: 'x', role: 'staff' });
    const projects = await import('../src/lib/projects');
    ownerProjectId = (await projects.createProject(owner.id, { title: 'Owner skin fade', clientName: 'Jordan', notes: '' })).id;
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('lets staff see and change only the projects they created, while the owner sees all', async () => {
    const listRoute = await import('../src/app/api/projects/route');
    const projectRoute = await import('../src/app/api/projects/[id]/route');
    const jobsRoute = await import('../src/app/api/projects/[id]/jobs/route');

    as(staff);
    const created = await call(listRoute.POST, 'POST', '/api/projects', {}, { title: 'Staff taper' });
    expect(created.status).toBe(201);
    expect(created.json.project.ownerId).toBe(staff.id);
    staffProjectId = created.json.project.id;

    const staffList = await call(listRoute.GET, 'GET', '/api/projects', {});
    expect(staffList.json.projects.map((p: { id: string }) => p.id)).toEqual([staffProjectId]);
    expect((await call(listRoute.GET, 'GET', '/api/projects?search=owner', {})).json.projects).toEqual([]);
    expect((await call(projectRoute.GET, 'GET', `/api/projects/${ownerProjectId}`, { id: ownerProjectId })).status).toBe(404);
    expect((await call(projectRoute.PATCH, 'PATCH', `/api/projects/${ownerProjectId}`, { id: ownerProjectId }, { title: 'Hijacked' })).status).toBe(404);
    expect((await call(jobsRoute.GET, 'GET', `/api/projects/${ownerProjectId}/jobs`, { id: ownerProjectId })).status).toBe(404);
    expect((await call(projectRoute.DELETE, 'DELETE', `/api/projects/${ownerProjectId}`, { id: ownerProjectId })).status).toBe(404);
    expect((await call(projectRoute.GET, 'GET', `/api/projects/${staffProjectId}`, { id: staffProjectId })).status).toBe(200);
    const renamed = await call(projectRoute.PATCH, 'PATCH', `/api/projects/${staffProjectId}`, { id: staffProjectId }, { title: 'Staff low taper' });
    expect(renamed.json.project.title).toBe('Staff low taper');
    expect((await call(jobsRoute.GET, 'GET', `/api/projects/${staffProjectId}/jobs`, { id: staffProjectId })).json.jobs).toEqual([]);

    as(owner);
    const ownerList = await call(listRoute.GET, 'GET', '/api/projects', {});
    expect(ownerList.json.projects.map((p: { id: string }) => p.id).sort()).toEqual([ownerProjectId, staffProjectId].sort());
    expect((await call(projectRoute.GET, 'GET', `/api/projects/${staffProjectId}`, { id: staffProjectId })).status).toBe(200);
    expect((await call(projectRoute.GET, 'GET', `/api/projects/${ownerProjectId}`, { id: ownerProjectId })).json.project.title).toBe('Owner skin fade');
  }, 60_000);

  it('limits job controls and the dashboard job list in the same way', async () => {
    const jobsLib = await import('../src/lib/jobs');
    const cancelRoute = await import('../src/app/api/jobs/[id]/cancel/route');
    const retryRoute = await import('../src/app/api/jobs/[id]/retry/route');
    const ownerJob = await jobsLib.createTrackedJob({ type: 'ingest.asset', payload: { assetId: 'asset-x', projectId: ownerProjectId } });
    const staffJob = await jobsLib.createTrackedJob({ type: 'ingest.asset', payload: { assetId: 'asset-y', projectId: staffProjectId } });
    const libraryJob = await jobsLib.createTrackedJob({ type: 'music.analyse', payload: { trackId: 'track-x' }, projectId: null });

    as(staff);
    expect((await jobsLib.listActiveJobs(staff)).map((j) => j.id)).toEqual([staffJob.id]);
    expect((await call(cancelRoute.POST, 'POST', `/api/jobs/${ownerJob.id}/cancel`, { id: ownerJob.id })).status).toBe(404);
    expect((await call(cancelRoute.POST, 'POST', `/api/jobs/${libraryJob.id}/cancel`, { id: libraryJob.id })).status).toBe(404);
    const cancelled = await call(cancelRoute.POST, 'POST', `/api/jobs/${staffJob.id}/cancel`, { id: staffJob.id });
    expect(cancelled.json.job.status).toBe('cancelled');
    expect((await call(retryRoute.POST, 'POST', `/api/jobs/${staffJob.id}/retry`, { id: staffJob.id })).json.job.status).toBe('queued');

    as(owner);
    expect((await jobsLib.listActiveJobs(owner)).map((j) => j.id).sort()).toEqual([ownerJob.id, staffJob.id, libraryJob.id].sort());
    expect((await call(cancelRoute.POST, 'POST', `/api/jobs/${ownerJob.id}/cancel`, { id: ownerJob.id })).status).toBe(200);
    expect((await call(cancelRoute.POST, 'POST', `/api/jobs/${libraryJob.id}/cancel`, { id: libraryJob.id })).status).toBe(200);
    expect((await call(retryRoute.POST, 'POST', `/api/jobs/${ownerJob.id}/retry`, { id: ownerJob.id })).status).toBe(200);
  }, 60_000);

  it('lets staff delete their own project but not the owner’s', async () => {
    const listRoute = await import('../src/app/api/projects/route');
    const projectRoute = await import('../src/app/api/projects/[id]/route');
    as(staff);
    const temp = await call(listRoute.POST, 'POST', '/api/projects', {}, { title: 'Delete me' });
    expect((await call(projectRoute.DELETE, 'DELETE', `/api/projects/${temp.json.project.id}`, { id: temp.json.project.id })).status).toBe(200);
    as(owner);
    expect((await call(projectRoute.GET, 'GET', `/api/projects/${ownerProjectId}`, { id: ownerProjectId })).status).toBe(200);
  }, 60_000);

  it('reorders clips in one request and refuses clips from elsewhere', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const orderRoute = await import('../src/app/api/projects/[id]/assets/order/route');
    const db = getDb();
    for (const [i, name] of ['before.mov', 'cut.mov', 'result.mov'].entries()) {
      const id = randomUUID();
      clipIds.push(id);
      await db.insert(schema.mediaAssets).values({
        id,
        projectId: ownerProjectId,
        kind: 'video',
        originalFilename: name,
        mimeType: 'video/quicktime',
        byteSize: 10,
        sortOrder: i,
        originalKey: `projects/${ownerProjectId}/assets/${id}/original.mov`,
        status: 'ready',
        analysis: fakeAnalysis(id),
      });
    }
    const staffClip = randomUUID();
    await db.insert(schema.mediaAssets).values({ id: staffClip, projectId: staffProjectId, kind: 'video', originalFilename: 'x.mov', mimeType: 'video/quicktime', byteSize: 1, originalKey: `projects/${staffProjectId}/assets/${staffClip}/original.mov` });
    const [a, b, c] = clipIds as [string, string, string];

    as(owner);
    const url = `/api/projects/${ownerProjectId}/assets/order`;
    const res = await call(orderRoute.POST, 'POST', url, { id: ownerProjectId }, { assetIds: [c, a] });
    expect(res.status).toBe(200);
    expect(res.json.assets).toEqual([
      { id: c, sortOrder: 0 },
      { id: a, sortOrder: 1 },
      { id: b, sortOrder: 2 },
    ]);
    const rows = await db.query.mediaAssets.findMany({ where: eq(schema.mediaAssets.projectId, ownerProjectId) });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.sortOrder]))).toEqual({ [c]: 0, [a]: 1, [b]: 2 });

    const foreign = await call(orderRoute.POST, 'POST', url, { id: ownerProjectId }, { assetIds: [a, staffClip] });
    expect(foreign.status).toBe(400);
    expect(foreign.json.error.message).toMatch(/not part of this project/);
    expect((await call(orderRoute.POST, 'POST', url, { id: ownerProjectId }, { assetIds: [a, a] })).status).toBe(400);
    expect((await call(orderRoute.POST, 'POST', url, { id: ownerProjectId }, { assetIds: [] })).status).toBe(400);
    // A failed request changes nothing.
    const after = await db.query.mediaAssets.findMany({ where: eq(schema.mediaAssets.projectId, ownerProjectId) });
    expect(Object.fromEntries(after.map((r) => [r.id, r.sortOrder]))).toEqual({ [c]: 0, [a]: 1, [b]: 2 });

    as(staff);
    expect((await call(orderRoute.POST, 'POST', url, { id: ownerProjectId }, { assetIds: [a, b, c] })).status).toBe(404);

    as(owner);
    const statusRoute = await import('../src/app/api/projects/[id]/status/route');
    const status = await call(statusRoute.GET, 'GET', `/api/projects/${ownerProjectId}/status`, { id: ownerProjectId });
    expect(status.json.assets.map((x: { id: string }) => x.id)).toEqual([c, a, b]);
  }, 60_000);

  it('lists the shots of a clip with signed frames and saves per-shot tags', async () => {
    const shotsRoute = await import('../src/app/api/assets/[id]/shots/route');
    const assetRoute = await import('../src/app/api/assets/[id]/route');
    const clip = clipIds[1]!;
    as(owner);
    const shots = await call(shotsRoute.GET, 'GET', `/api/assets/${clip}/shots`, { id: clip });
    expect(shots.status).toBe(200);
    expect(shots.json.shots).toHaveLength(5);
    expect(shots.json.shots[0]).toMatchObject({ id: `${clip}-s0`, startSec: 0, endSec: 2, label: 'before', source: 'heuristic', manualLabel: null });
    expect(shots.json.shots[0].frameUrl).toMatch(/^\/api\/media\//);
    expect(JSON.stringify(shots.json)).not.toContain('storageKey');

    const tagged = await call(assetRoute.PATCH, 'PATCH', `/api/assets/${clip}`, { id: clip }, { manualLabels: { [`${clip}-s0`]: 'cutting' } });
    expect(tagged.status).toBe(200);
    expect(tagged.json.styles).toHaveLength(5);
    const again = await call(shotsRoute.GET, 'GET', `/api/assets/${clip}/shots`, { id: clip });
    expect(again.json.shots[0]).toMatchObject({ label: 'cutting', source: 'shot_tag', manualLabel: 'cutting', detectedLabel: 'before' });
    expect(again.json.manualLabels).toEqual({ [`${clip}-s0`]: 'cutting' });
    const unknown = await call(assetRoute.PATCH, 'PATCH', `/api/assets/${clip}`, { id: clip }, { manualLabels: { 'not-a-shot': 'result' } });
    expect(unknown.status).toBe(400);
    // Clearing the tags brings every style back (the before shot is "before" again).
    await call(assetRoute.PATCH, 'PATCH', `/api/assets/${clip}`, { id: clip }, { manualLabels: {} });

    as(staff);
    expect((await call(shotsRoute.GET, 'GET', `/api/assets/${clip}/shots`, { id: clip })).status).toBe(404);
  }, 60_000);

  it('confirms a track licence from Settings and only then lets Generate use it', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const musicRoute = await import('../src/app/api/music/[id]/route');
    const generateRoute = await import('../src/app/api/projects/[id]/generate/route');
    trackId = randomUUID();
    const beatTimesSec = Array.from({ length: 80 }, (_, i) => Math.round((0.05 + i * 0.5) * 1000) / 1000);
    await getDb()
      .insert(schema.musicTracks)
      .values({
        id: trackId,
        projectId: null,
        title: 'Studio beat',
        storageKey: `music/${trackId}/original.mp3`,
        mimeType: 'audio/mpeg',
        byteSize: 100,
        durationSec: 40,
        bpm: 120,
        beats: { beatTimesSec, energy: Array.from({ length: 160 }, (_, i) => (i % 8) / 8), energyStepSec: 0.25 },
        licence: LICENCE,
        status: 'ready',
      });

    as(owner);
    const url = `/api/projects/${ownerProjectId}/generate`;
    const unconfirmed = await call(generateRoute.POST, 'POST', url, { id: ownerProjectId }, { styles: ['beat_montage'], musicTrackId: trackId });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.json.error.message).toMatch(/Confirm the licence/);

    const confirmed = await call(musicRoute.PATCH, 'PATCH', `/api/music/${trackId}`, { id: trackId }, { licence: { ...LICENCE, confirmedByOwnerAt: '2000-01-01T00:00:00.000Z' }, confirmLicence: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.track.licenceConfirmed).toBe(true);
    // The browser cannot choose the confirmation time.
    expect(confirmed.json.track.licence.confirmedByOwnerAt).not.toBe('2000-01-01T00:00:00.000Z');
    const withdrawn = await call(musicRoute.PATCH, 'PATCH', `/api/music/${trackId}`, { id: trackId }, { confirmLicence: false });
    expect(withdrawn.json.track.licenceConfirmed).toBe(false);
    await call(musicRoute.PATCH, 'PATCH', `/api/music/${trackId}`, { id: trackId }, { licence: { ...LICENCE, licenceName: 'Social licence 2026' }, confirmLicence: true });
    const row = await getDb().query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, trackId) });
    expect(row?.licence).toMatchObject({ licenceName: 'Social licence 2026' });
    expect(row?.licence.confirmedByOwnerAt).toBeTruthy();

    const statusRoute = await import('../src/app/api/projects/[id]/status/route');
    const status = await call(statusRoute.GET, 'GET', `/api/projects/${ownerProjectId}/status`, { id: ownerProjectId });
    const option = status.json.music.find((m: { id: string }) => m.id === trackId);
    expect(option).toMatchObject({ bpm: 120, licenceConfirmed: true, durationSec: 40 });
    expect(option.energy.values.length).toBeLessThanOrEqual(120);
    expect(option.energy.stepSec).toBeGreaterThan(0);
  }, 60_000);

  it('checks the music start point against the real track before generating', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const generateRoute = await import('../src/app/api/projects/[id]/generate/route');
    const url = `/api/projects/${ownerProjectId}/generate`;
    as(owner);
    const post = (body: Record<string, unknown>) => call(generateRoute.POST, 'POST', url, { id: ownerProjectId }, { styles: ['beat_montage'], durationSec: 20, ...body });

    const noTrack = await post({ musicStartSec: 5 });
    expect(noTrack.status).toBe(400);
    expect(noTrack.json.error.message).toMatch(/Choose a music track/);
    const negative = await post({ musicTrackId: trackId, musicStartSec: -1 });
    expect(negative.status).toBe(400);
    const pastEnd = await post({ musicTrackId: trackId, musicStartSec: 45 });
    expect(pastEnd.status).toBe(400);
    expect(pastEnd.json.error.message).toMatch(/only 0:40 long/);
    const tooLate = await post({ musicTrackId: trackId, musicStartSec: 30 });
    expect(tooLate.status).toBe(400);
    expect(tooLate.json.error.message).toMatch(/leaves 10 seconds of the track, but the edit is 20 seconds/);

    const ok = await post({ musicTrackId: trackId, musicStartSec: 12.5 });
    expect(ok.status).toBe(201);
    const generation = await getDb().query.generations.findFirst({ where: eq(schema.generations.id, ok.json.generationId) });
    expect(generation?.settings).toMatchObject({ musicTrackId: trackId, musicStartSec: 12.5, durationSec: 20 });
    const project = await getDb().query.projects.findFirst({ where: eq(schema.projects.id, ownerProjectId) });
    expect(project?.lastSettings?.musicStartSec).toBe(12.5);
  }, 60_000);

  it('uploads a licensed track from Settings into the library', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const libraryUploadRoute = await import('../src/app/api/music/uploads/route');
    const partRoute = await import('../src/app/api/uploads/[id]/parts/[n]/route');
    const completeRoute = await import('../src/app/api/uploads/[id]/complete/route');

    as(loner);
    const nowhere = await call(libraryUploadRoute.POST, 'POST', '/api/music/uploads', {}, { filename: 'beat.mp3', size: 10, mimeType: 'audio/mpeg' });
    expect(nowhere.status).toBe(409);
    expect(nowhere.json.error.message).toMatch(/Create a project/);

    as(staff);
    const video = await call(libraryUploadRoute.POST, 'POST', '/api/music/uploads', {}, { filename: 'clip.mp4', size: 10, mimeType: 'video/mp4' });
    expect(video.status).toBe(400);
    const audio = new Uint8Array(randomBytes(3000));
    const created = await call(libraryUploadRoute.POST, 'POST', '/api/music/uploads', {}, { filename: 'Fresh beat.mp3', size: audio.length, mimeType: 'audio/mpeg', kind: 'video' });
    expect(created.status).toBe(201);
    const uploadId: string = created.json.uploadId;
    const session = await getDb().query.uploadSessions.findFirst({ where: eq(schema.uploadSessions.id, uploadId) });
    // Staff uploads ride on a project they can open, and are always music.
    expect(session).toMatchObject({ projectId: staffProjectId, kind: 'audio' });
    await call(partRoute.PUT, 'PUT', `/api/uploads/${uploadId}/parts/1`, { id: uploadId, n: '1' }, audio);
    const unconfirmed = await call(completeRoute.POST, 'POST', `/api/uploads/${uploadId}/complete`, { id: uploadId }, { title: 'Fresh beat', licence: LICENCE });
    expect(unconfirmed.status).toBe(400);
    const done = await call(completeRoute.POST, 'POST', `/api/uploads/${uploadId}/complete`, { id: uploadId }, { title: 'Fresh beat', licence: LICENCE, confirmLicence: true });
    expect(done.status).toBe(200);
    expect(done.json.kind).toBe('audio');
    const track = await getDb().query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, done.json.assetId) });
    expect(track).toMatchObject({ projectId: null, title: 'Fresh beat', status: 'uploaded' });
    expect(track?.licence.confirmedByOwnerAt).toBeTruthy();
    const jobs = await getDb().query.jobs.findMany({ where: eq(schema.jobs.refId, done.json.assetId) });
    expect(jobs.map((j) => j.type)).toEqual(['music.analyse']);
  }, 60_000);
});
