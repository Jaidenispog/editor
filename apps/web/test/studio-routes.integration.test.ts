import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssetAnalysis, EditPlan } from '@studio/core';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Calls the Video Studio route handlers directly against a throwaway database (TEST_DATABASE_URL) and a temporary
 * local storage folder: upload → parts → complete, tagging, generate, revise, version switching, favourite and
 * export idempotency. The session lookup is replaced so the handlers see a signed-in user; everything else
 * (CSRF guard, validation, database, storage, pg-boss queue) is real. Skipped when TEST_DATABASE_URL is unset.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

const auth = vi.hoisted(() => ({ session: null as null | { sessionId: string; user: { id: string; email: string; displayName: string; role: 'owner' | 'staff' }; expiresAt: Date } }));

vi.mock('../src/lib/session', () => ({
  getCurrentSession: async () => auth.session,
  getCurrentUser: async () => auth.session?.user ?? null,
  getSessionToken: async () => undefined,
  setSessionCookie: async () => undefined,
  clearSessionCookie: async () => undefined,
}));

const ORIGIN = 'http://localhost:3000';
const MiB = 1024 * 1024;

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

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
      durationSec: 12,
      fileSizeBytes: 1,
      video: { codec: 'h264', codedWidth: 1080, codedHeight: 1920, displayWidth: 1080, displayHeight: 1920, rotation: 0, fps: 30, pixelFormat: 'yuv420p', bitDepth: 8, colour: { primaries: null, transfer: null, matrix: null, range: null }, isHdr: false, hdrFormat: null, bitrate: null },
      audio: null,
    },
    shots: labels.map((label, i) => ({ id: `${assetId}-s${i}`, assetId, startSec: i * 2, endSec: i * 2 + 2, quality, label, labelSource: 'heuristic' as const, confidence: 0.6, description: '', framing: 'unknown' as const, focus: null, issues: [] })),
    sampledFrames: [],
    audio: { hasAudio: false, integratedLoudnessLufs: null, silenceRatio: 1, speechLikely: false, speechConfidence: 0 },
    transcript: null,
    labelling: { source: 'heuristic', model: null, note: '' },
    completedAt: new Date().toISOString(),
  };
}

suite('Video Studio routes (database-backed)', () => {
  const dbName = `sa_studiotest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let storageRoot = '';
  let projectId = '';
  let assetId = '';
  let ownerId = '';
  let staffUser: { id: string; email: string; displayName: string; role: 'staff' } | null = null;
  const fileBytes = randomBytes(8 * MiB + 12_345);

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-studio-storage-'));
    process.env.DATABASE_URL = url.toString();
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';

    const authLib = await import('../src/lib/auth');
    const owner = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    ownerId = owner.id;
    auth.session = { sessionId: 'test', user: { id: owner.id, email: owner.email, displayName: owner.displayName, role: 'owner' }, expiresAt: new Date(Date.now() + 3600_000) };
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const staffId = randomUUID();
    await getDb().insert(schema.users).values({ id: staffId, email: 'staff@example.com', displayName: 'Staff', passwordHash: 'x', role: 'staff' });
    staffUser = { id: staffId, email: 'staff@example.com', displayName: 'Staff', role: 'staff' };
    const projects = await import('../src/lib/projects');
    const project = await projects.createProject(owner.id, { title: 'Jordan skin fade', clientName: 'Jordan', notes: '' });
    projectId = project.id;
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('uploads a clip in parts, resumes, completes once and queues analysis', async () => {
    const createRoute = await import('../src/app/api/projects/[id]/uploads/route');
    const partRoute = await import('../src/app/api/uploads/[id]/parts/[n]/route');
    const uploadRoute = await import('../src/app/api/uploads/[id]/route');
    const completeRoute = await import('../src/app/api/uploads/[id]/complete/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');

    const bad = await call(createRoute.POST, 'POST', `/api/projects/${projectId}/uploads`, { id: projectId }, { filename: 'clip.avi', size: 10, mimeType: 'video/x-msvideo', kind: 'video' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/\.mov, \.mp4 and \.m4v/);
    const tooBig = await call(createRoute.POST, 'POST', `/api/projects/${projectId}/uploads`, { id: projectId }, { filename: 'clip.mp4', size: 7 * 1024 ** 3, mimeType: 'video/mp4', kind: 'video' });
    expect(tooBig.status).toBe(400);

    const created = await call(createRoute.POST, 'POST', `/api/projects/${projectId}/uploads`, { id: projectId }, { filename: 'IMG_0001.MOV', size: fileBytes.length, mimeType: 'video/quicktime', kind: 'video' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ partSize: 8 * MiB, partCount: 2, receivedParts: [], status: 'open' });
    const uploadId: string = created.json.uploadId;

    const part1 = new Uint8Array(fileBytes.subarray(0, 8 * MiB));
    const part2 = new Uint8Array(fileBytes.subarray(8 * MiB));
    const early = await call(completeRoute.POST, 'POST', `/api/uploads/${uploadId}/complete`, { id: uploadId }, {});
    expect(early.status).toBe(409);
    const wrongSize = await call(partRoute.PUT, 'PUT', `/api/uploads/${uploadId}/parts/2`, { id: uploadId, n: '2' }, new Uint8Array(10));
    expect(wrongSize.status).toBe(400);
    expect((await call(partRoute.PUT, 'PUT', `/api/uploads/${uploadId}/parts/2`, { id: uploadId, n: '2' }, part2)).json.receivedParts).toEqual([2]);
    const [a, b] = await Promise.all([
      call(partRoute.PUT, 'PUT', `/api/uploads/${uploadId}/parts/1`, { id: uploadId, n: '1' }, part1),
      call(partRoute.PUT, 'PUT', `/api/uploads/${uploadId}/parts/1`, { id: uploadId, n: '1' }, part1),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const resumed = await call(uploadRoute.GET, 'GET', `/api/uploads/${uploadId}`, { id: uploadId });
    expect(resumed.json.receivedParts).toEqual([1, 2]);

    const done = await call(completeRoute.POST, 'POST', `/api/uploads/${uploadId}/complete`, { id: uploadId }, {});
    expect(done.status).toBe(200);
    assetId = done.json.assetId;
    const again = await call(completeRoute.POST, 'POST', `/api/uploads/${uploadId}/complete`, { id: uploadId }, {});
    expect(again.json.assetId).toBe(assetId);

    const db = getDb();
    const asset = await db.query.mediaAssets.findFirst({ where: eq(schema.mediaAssets.id, assetId) });
    expect(asset).toMatchObject({ projectId, kind: 'video', status: 'uploaded', sortOrder: 0, byteSize: fileBytes.length, originalFilename: 'IMG_0001.MOV' });
    const stored = await readFile(path.join(storageRoot, asset?.originalKey ?? 'missing'));
    expect(stored.equals(fileBytes)).toBe(true);
    const jobs = await db.query.jobs.findMany({ where: eq(schema.jobs.refId, assetId) });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'ingest.asset', status: 'queued', projectId });
    expect(jobs[0]?.bossJobId).toBeTruthy();
    const session = await db.query.uploadSessions.findFirst({ where: eq(schema.uploadSessions.id, uploadId) });
    expect(session).toMatchObject({ status: 'completed', assetId });

    // Another person's project is invisible to staff.
    const saved = auth.session;
    auth.session = { sessionId: 'staff', user: staffUser!, expiresAt: new Date(Date.now() + 3600_000) };
    expect((await call(uploadRoute.GET, 'GET', `/api/uploads/${uploadId}`, { id: uploadId })).status).toBe(404);
    auth.session = saved;

    // Cancelling an unfinished upload removes it.
    const second = await call(createRoute.POST, 'POST', `/api/projects/${projectId}/uploads`, { id: projectId }, { filename: 'clip2.mp4', size: 100, mimeType: 'video/mp4', kind: 'video' });
    expect((await call(uploadRoute.DELETE, 'DELETE', `/api/uploads/${second.json.uploadId}`, { id: second.json.uploadId })).status).toBe(204);
    expect((await call(partRoute.PUT, 'PUT', `/api/uploads/${second.json.uploadId}/parts/1`, { id: second.json.uploadId, n: '1' }, new Uint8Array(100))).status).toBe(409);
  }, 60_000);

  it('uploads licensed music only with the owner confirmation and queues beat analysis', async () => {
    const createRoute = await import('../src/app/api/projects/[id]/uploads/route');
    const partRoute = await import('../src/app/api/uploads/[id]/parts/[n]/route');
    const completeRoute = await import('../src/app/api/uploads/[id]/complete/route');
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    const audio = new Uint8Array(randomBytes(4000));
    const created = await call(createRoute.POST, 'POST', `/api/projects/${projectId}/uploads`, { id: projectId }, { filename: 'beat.mp3', size: audio.length, mimeType: 'audio/mpeg', kind: 'audio' });
    expect(created.status).toBe(201);
    const id: string = created.json.uploadId;
    await call(partRoute.PUT, 'PUT', `/api/uploads/${id}/parts/1`, { id, n: '1' }, audio);
    const licence = { kind: 'commercial_licence', source: 'Library', permitted: { promotionalUse: true, instagram: true, tiktok: true } };
    const unconfirmed = await call(completeRoute.POST, 'POST', `/api/uploads/${id}/complete`, { id }, { title: 'Beat', licence });
    expect(unconfirmed.status).toBe(400);
    const done = await call(completeRoute.POST, 'POST', `/api/uploads/${id}/complete`, { id }, { title: 'Beat', licence, confirmLicence: true });
    expect(done.status).toBe(200);
    const track = await getDb().query.musicTracks.findFirst({ where: eq(schema.musicTracks.id, done.json.assetId) });
    expect(track).toMatchObject({ projectId: null, title: 'Beat', status: 'uploaded', mimeType: 'audio/mpeg' });
    expect(track?.licence.confirmedByOwnerAt).toBeTruthy();
    const jobs = await getDb().query.jobs.findMany({ where: eq(schema.jobs.refId, done.json.assetId) });
    expect(jobs.map((j) => j.type)).toEqual(['music.analyse']);
  }, 60_000);

  it('tags clips, generates one edit per style, revises without losing versions and exports once', async () => {
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { and, eq } = await import('drizzle-orm');
    const assetRoute = await import('../src/app/api/assets/[id]/route');
    const generateRoute = await import('../src/app/api/projects/[id]/generate/route');
    const statusRoute = await import('../src/app/api/projects/[id]/status/route');
    const reviseRoute = await import('../src/app/api/edits/[id]/revise/route');
    const regenerateRoute = await import('../src/app/api/edits/[id]/regenerate/route');
    const currentRoute = await import('../src/app/api/edits/[id]/current-version/route');
    const favouriteRoute = await import('../src/app/api/edits/[id]/favourite/route');
    const exportRoute = await import('../src/app/api/edit-versions/[id]/export/route');
    const downloadRoute = await import('../src/app/api/edit-versions/[id]/download/route');
    const db = getDb();

    // Generating while the clip is still waiting for analysis is refused.
    const early = await call(generateRoute.POST, 'POST', `/api/projects/${projectId}/generate`, { id: projectId }, { styles: ['beat_montage'] });
    expect(early.status).toBe(409);

    // Pretend the worker finished analysing the clip (heuristic labels).
    await db.update(schema.mediaAssets).set({ status: 'ready', analysis: fakeAnalysis(assetId), statusMessage: '5 shots' }).where(eq(schema.mediaAssets.id, assetId));

    const tagged = await call(assetRoute.PATCH, 'PATCH', `/api/assets/${assetId}`, { id: assetId }, { clipLabel: 'result' });
    expect(tagged.status).toBe(200);
    const taggedStyles = tagged.json.styles as Array<{ id: string; supported: boolean }>;
    expect(taggedStyles.find((s) => s.id === 'before_after')?.supported).toBe(false);
    const cleared = await call(assetRoute.PATCH, 'PATCH', `/api/assets/${assetId}`, { id: assetId }, { clipLabel: null });
    expect((cleared.json.styles as Array<{ supported: boolean }>).every((s) => s.supported)).toBe(true);
    const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    expect(project?.styleSupport?.every((s) => s.supported)).toBe(true);

    const styles = ['process_story', 'beat_montage', 'cinematic_reveal', 'before_after', 'clean_promo'];
    const gen = await call(generateRoute.POST, 'POST', `/api/projects/${projectId}/generate`, { id: projectId }, { styles, durationSec: 20 });
    expect(gen.status).toBe(201);
    const generationId: string = gen.json.generationId;
    expect(gen.json.edits.map((e: { styleId: string; slot: number }) => [e.slot, e.styleId])).toEqual([
      [0, 'beat_montage'],
      [1, 'cinematic_reveal'],
      [2, 'before_after'],
      [3, 'clean_promo'],
      [4, 'process_story'],
    ]);
    const edits = await db.query.edits.findMany({ where: eq(schema.edits.generationId, generationId) });
    expect(edits).toHaveLength(5);
    for (const e of edits) {
      const versions = await db.query.editVersions.findMany({ where: eq(schema.editVersions.editId, e.id) });
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ id: e.currentVersionId, versionNo: 1, origin: 'initial', status: 'planning' });
    }
    const genJobs = await db.query.jobs.findMany({ where: eq(schema.jobs.refId, generationId) });
    expect(genJobs.map((j) => j.type)).toEqual(['edits.generate']);
    const updatedProject = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
    expect(updatedProject?.lastSettings).toMatchObject({ durationSec: 20, styles: ['beat_montage', 'cinematic_reveal', 'before_after', 'clean_promo', 'process_story'] });
    const twice = await call(generateRoute.POST, 'POST', `/api/projects/${projectId}/generate`, { id: projectId }, { styles: ['beat_montage'] });
    expect(twice.status).toBe(409);

    // The worker would plan and render; simulate a finished preview for the first edit.
    const edit = edits.find((e) => e.styleId === 'beat_montage')!;
    const v1 = edit.currentVersionId!;
    const plan = { segments: [{ assetId }] } as unknown as EditPlan;
    await db.update(schema.editVersions).set({ status: 'preview_ready', plan, planSource: 'rules', previewKey: `projects/${projectId}/edits/${edit.id}/v1/preview.mp4` }).where(eq(schema.editVersions.id, v1));
    await db.update(schema.generations).set({ status: 'complete' }).where(eq(schema.generations.id, generationId));

    const status = await call(statusRoute.GET, 'GET', `/api/projects/${projectId}/status`, { id: projectId });
    expect(status.status).toBe(200);
    expect(status.json.generations[0].edits).toHaveLength(5);
    expect(status.json.generations[0].edits[0].versions[0].previewUrl).toMatch(/\/api\/media\//);
    expect(status.json.busy).toBe(true);
    expect(JSON.stringify(status.json)).not.toContain('previewKey');

    const revised = await call(reviseRoute.POST, 'POST', `/api/edits/${edit.id}/revise`, { id: edit.id }, { instruction: 'Make this 15 seconds' });
    expect(revised.status).toBe(201);
    expect(revised.json.versionNo).toBe(2);
    const v2 = revised.json.versionId as string;
    const versions = await db.query.editVersions.findMany({ where: eq(schema.editVersions.editId, edit.id) });
    expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
    expect(versions.find((v) => v.id === v2)).toMatchObject({ parentVersionId: v1, origin: 'revise', instruction: 'Make this 15 seconds', status: 'planning' });
    expect(versions.find((v) => v.id === v1)).toMatchObject({ status: 'preview_ready' });
    expect((await db.query.edits.findFirst({ where: eq(schema.edits.id, edit.id) }))?.currentVersionId).toBe(v2);
    const reviseJob = await db.query.jobs.findFirst({ where: eq(schema.jobs.refId, v2) });
    expect(reviseJob).toMatchObject({ type: 'edits.revise', payload: { editId: edit.id, newVersionId: v2, mode: 'revise', projectId } });
    expect((await call(regenerateRoute.POST, 'POST', `/api/edits/${edit.id}/regenerate`, { id: edit.id }, {})).status).toBe(409);

    const back = await call(currentRoute.POST, 'POST', `/api/edits/${edit.id}/current-version`, { id: edit.id }, { versionId: v1 });
    expect(back.json).toEqual({ currentVersionId: v1 });
    const otherEdit = edits.find((e) => e.id !== edit.id)!;
    expect((await call(currentRoute.POST, 'POST', `/api/edits/${otherEdit.id}/current-version`, { id: otherEdit.id }, { versionId: v1 })).status).toBe(404);

    const fav = await call(favouriteRoute.POST, 'POST', `/api/edits/${edit.id}/favourite`, { id: edit.id }, { value: true });
    expect(fav.json).toEqual({ isFavourite: true });
    const feedback = await db.query.feedbackEvents.findMany({ where: and(eq(schema.feedbackEvents.editId, edit.id), eq(schema.feedbackEvents.type, 'favourite')) });
    expect(feedback).toHaveLength(1);
    // Style affinity is written by the debounced preferences.recompute job (WP2), never in the request.
    const { getSettings } = await import('../src/lib/settings');
    expect((await getSettings()).preferences.styleAffinity['beat_montage']).toBeUndefined();
    expect((await db.query.jobs.findMany({ where: eq(schema.jobs.type, 'preferences.recompute') })).length).toBeGreaterThanOrEqual(1);

    const notReady = await call(downloadRoute.GET, 'GET', `/api/edit-versions/${v1}/download`, { id: v1 });
    expect(notReady.status).toBe(409);
    expect((await call(exportRoute.POST, 'POST', `/api/edit-versions/${v2}/export`, { id: v2 })).status).toBe(409);
    const first = await call(exportRoute.POST, 'POST', `/api/edit-versions/${v1}/export`, { id: v1 });
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ exportStatus: 'queued' });
    const second = await call(exportRoute.POST, 'POST', `/api/edit-versions/${v1}/export`, { id: v1 });
    expect(second.json).toMatchObject({ exportStatus: 'queued', jobId: first.json.jobId });
    const exportJobs = await db.query.jobs.findMany({ where: and(eq(schema.jobs.refId, v1), eq(schema.jobs.type, 'render.export')) });
    expect(exportJobs).toHaveLength(1);

    const { getBlobStore } = await import('../src/lib/storage');
    const exportKey = `projects/${projectId}/edits/${edit.id}/v1/export.mp4`;
    await getBlobStore().put(exportKey, Buffer.from('fake mp4 bytes for the link test'));
    await db.update(schema.editVersions).set({ exportStatus: 'ready', exportKey, exportByteSize: 32 }).where(eq(schema.editVersions.id, v1));
    const link = await call(downloadRoute.GET, 'GET', `/api/edit-versions/${v1}/download`, { id: v1 });
    expect(link.status).toBe(200);
    expect(link.json.filename).toBe('jordan-skin-fade-beat-synced-montage-v1.mp4');
    expect(link.json.url).toMatch(/\/api\/media\//);
    const preview = await call(downloadRoute.GET, 'GET', `/api/edit-versions/${v1}/download?kind=preview`, { id: v1 });
    expect(preview.json.filename).toBe('jordan-skin-fade-beat-synced-montage-v1-preview.mp4');
    expect((await call(exportRoute.POST, 'POST', `/api/edit-versions/${v1}/export`, { id: v1 })).json.exportStatus).toBe('ready');
  }, 60_000);

  it('refuses requests from other sites and removes a clip with its files', async () => {
    const assetRoute = await import('../src/app/api/assets/[id]/route');
    const res = await (assetRoute.DELETE as unknown as Handler)(new NextRequest(`${ORIGIN}/api/assets/${assetId}`, { method: 'DELETE', headers: { origin: 'https://evil.example' } }), {
      params: Promise.resolve({ id: assetId }),
    });
    expect(res.status).toBe(403);
    const removed = await call(assetRoute.DELETE, 'DELETE', `/api/assets/${assetId}`, { id: assetId });
    expect(removed.status).toBe(200);
    const { getDb } = await import('../src/lib/db');
    const { schema } = await import('@studio/db');
    const { eq } = await import('drizzle-orm');
    expect(await getDb().query.mediaAssets.findFirst({ where: eq(schema.mediaAssets.id, assetId) })).toBeUndefined();
    const { getBlobStore } = await import('../src/lib/storage');
    expect(await getBlobStore().list(`projects/${projectId}/assets/${assetId}`)).toEqual([]);
    expect(ownerId).toBeTruthy();
  }, 60_000);
});
