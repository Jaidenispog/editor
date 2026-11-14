import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * Exercises the database-backed helpers (auth, settings, trends, projects, jobs) against a throwaway database
 * on the Postgres named by TEST_DATABASE_URL. Skipped when it is not set; never touches the app database.
 */
const base = process.env.TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;

suite('database-backed helpers', () => {
  const dbName = `sa_webtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let storageRoot = '';
  const meta = { ipAddress: '203.0.113.7', userAgent: 'vitest' };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    await runMigrations(url.toString());
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-web-storage-'));
    process.env.DATABASE_URL = url.toString();
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';
  }, 60_000);

  afterAll(async () => {
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  it('creates the owner once, signs in, throttles failures and manages sessions', async () => {
    const auth = await import('../src/lib/auth');
    expect(await auth.countUsers()).toBe(0);
    const owner = await auth.createOwnerAccount({ email: 'Owner@Example.com', password: 'a long owner password', displayName: 'Sam Owner' });
    expect(owner.role).toBe('owner');
    await expect(auth.createOwnerAccount({ email: 'second@example.com', password: 'another long password', displayName: 'X' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const signedIn = await auth.authenticate('owner@example.com', 'a long owner password', meta);
    expect(signedIn.id).toBe(owner.id);
    await expect(auth.authenticate('owner@example.com', 'wrong password!!', meta)).rejects.toMatchObject({ code: 'UNAUTHORISED' });
    await expect(auth.authenticate('nobody@example.com', 'whatever password', meta)).rejects.toMatchObject({ code: 'UNAUTHORISED' });

    const { token } = await auth.createSession(owner.id, meta);
    const session = await auth.validateSession(token);
    expect(session?.user.email).toBe('Owner@Example.com');
    expect(session?.sessionId).not.toBe(token);
    const second = await auth.createSession(owner.id, { ...meta, userAgent: 'other device' });
    expect((await auth.listUserSessions(owner.id)).length).toBe(2);

    const changed = await auth.changePassword(owner.id, session?.sessionId ?? '', 'a long owner password', 'a brand new password');
    expect(changed.signedOutSessions).toBe(1);
    expect(await auth.validateSession(second.token)).toBeNull();
    await expect(auth.changePassword(owner.id, session?.sessionId ?? '', 'wrong current pw', 'whatever new password')).rejects.toMatchObject({ code: 'VALIDATION' });

    await auth.destroySession(token);
    expect(await auth.validateSession(token)).toBeNull();

    const throttledMeta = { ipAddress: '198.51.100.9', userAgent: 'vitest' };
    for (let i = 0; i < 8; i++) {
      await expect(auth.authenticate('target@example.com', `bad password ${i}`, throttledMeta)).rejects.toMatchObject({ code: 'UNAUTHORISED' });
    }
    await expect(auth.authenticate('target@example.com', 'bad password again', throttledMeta)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  }, 60_000);

  it('creates settings on first load, seeds curated trends once and validates updates', async () => {
    const { getSettings, updateSettings } = await import('../src/lib/settings');
    const { listTrends } = await import('../src/lib/trends');
    const settings = await getSettings();
    expect(settings.brand.accentColour).toBe('#C8A24A');
    const trends = await listTrends();
    // Fresh install: the re-sourced curated list (research memo §11), labelled by trendLabel.
    expect(trends).toHaveLength(11);
    expect(trends.every((t) => t.kind === 'curated' && !/trending|viral/i.test(t.label))).toBe(true);

    const updated = await updateSettings({ brand: { accentColour: '#336699' }, preferences: { pacing: 'fast' } }, null);
    expect(updated.brand.accentColour).toBe('#336699');
    expect((await getSettings()).preferences.pacing).toBe('fast');
    await expect(updateSettings({ brand: { accentColour: 'blue' } }, null)).rejects.toThrow();
  }, 60_000);

  it('creates, lists and permanently deletes a project with its stored files and jobs', async () => {
    const auth = await import('../src/lib/auth');
    const projects = await import('../src/lib/projects');
    const jobs = await import('../src/lib/jobs');
    const { getBlobStore } = await import('../src/lib/storage');
    const owner = await auth.authenticate('owner@example.com', 'a brand new password', meta);
    const project = await projects.createProject(owner.id, { title: 'Skin fade', clientName: 'Jordan', notes: '' });
    const list = await projects.listProjects(owner);
    expect(list.map((p) => p.id)).toContain(project.id);
    expect(list.find((p) => p.id === project.id)).toMatchObject({ assetCount: 0, latestGeneration: null });
    expect((await projects.listProjects(owner, { search: 'jord' })).length).toBe(1);
    expect((await projects.listProjects(owner, { search: 'zzz' })).length).toBe(0);

    const job = await jobs.createTrackedJob({ type: 'ingest.asset', payload: { assetId: 'asset-1', projectId: project.id } });
    expect(job.status).toBe('queued');
    expect(job.bossJobId).toBeTruthy();
    expect(job.refId).toBe('asset-1');
    const cancelled = await jobs.cancelJob(job.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelRequested: true });
    const retried = await jobs.retryJob(job.id);
    expect(retried).toMatchObject({ status: 'queued', cancelRequested: false });

    const store = getBlobStore();
    await store.put(`projects/${project.id}/assets/a/original.mp4`, Buffer.from('video bytes'));
    const result = await projects.deleteProjectPermanently(project.id, owner);
    expect(result.filesRemoved).toBe(1);
    expect(await store.exists(`projects/${project.id}/assets/a/original.mp4`)).toBe(false);
    const { getAccessibleProject } = await import('../src/lib/studio-access');
    await expect(getAccessibleProject(project.id, owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(jobs.getJob(job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 60_000);
});
