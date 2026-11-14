import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '@studio/db';
import { dropTestDatabase } from './helpers/test-database';

/**
 * The settings row has two kinds of writer: the web app (owner saves, the logo upload, the Spotify mode) and the
 * worker's preferences.recompute job, which writes only `preferences.learned` / `preferences.styleAffinity` with
 * jsonb_set in one UPDATE. These tests run both at once against a throwaway database (TEST_DATABASE_URL), in both
 * orders, with the interleaving forced by holding the worker's transaction open, and check that nothing the job
 * learned is replaced by a stale copy. Skipped when TEST_DATABASE_URL is unset.
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
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

/** What the recompute job would have learned (shape of LearnedPreferences). */
function learnedValue(events: number) {
  return {
    computedAt: new Date().toISOString(),
    eventsConsidered: events,
    since: null,
    error: null,
    fields: { pacing: { value: 'fast', weight: 9, counts: { favourites: events, downloads: 0, publishes: 0, revisions: 0, regenerations: 0, dismissals: 0 }, explanation: `From ${events} favourites.` } },
  };
}

/** The UPDATE apps/worker/src/handlers/preferences.ts (writeLearned) issues: only the two learned subtrees change. */
const RECOMPUTE_SQL = `UPDATE settings
  SET data = jsonb_set(jsonb_set(data, '{preferences,learned}', $1::jsonb, true), '{preferences,styleAffinity}', $2::jsonb, true), updated_at = now()
  WHERE id = 'default'`;

suite('settings writes during a preferences recompute (database-backed)', () => {
  const dbName = `sa_setrace_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let dbUrl = '';
  let storageRoot = '';
  let worker: pg.Client;
  let observer: pg.Client;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = new URL(base ?? '');
    url.pathname = `/${dbName}`;
    dbUrl = url.toString();
    await runMigrations(dbUrl);
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'sa-setrace-storage-'));
    process.env.DATABASE_URL = dbUrl;
    process.env.STORAGE_LOCAL_ROOT = storageRoot;
    process.env.STORAGE_DRIVER = 'local';
    process.env.APP_URL = ORIGIN;
    process.env.APP_SECRET ??= 'test-secret-test-secret-test-secret-0123';

    const authLib = await import('../src/lib/auth');
    const o = await authLib.createOwnerAccount({ email: 'owner@example.com', password: 'a long owner password', displayName: 'Owner' });
    auth.session = { sessionId: 's-owner', user: { id: o.id, email: o.email, displayName: o.displayName, role: 'owner' }, expiresAt: new Date(Date.now() + 3600_000) };
    await (await import('../src/lib/settings')).getSettings(); // creates the settings row
    worker = new pg.Client({ connectionString: dbUrl, application_name: 'test-recompute' });
    observer = new pg.Client({ connectionString: dbUrl, application_name: 'test-observer' });
    await worker.connect();
    await observer.connect();
  }, 60_000);

  afterAll(async () => {
    await worker?.end().catch(() => undefined);
    await observer?.end().catch(() => undefined);
    const g = globalThis as unknown as { __studioWebDb?: { close(): Promise<void> }; __studioWebQueue?: Promise<{ stop(graceful?: boolean): Promise<void> }> };
    if (g.__studioWebQueue) await (await g.__studioWebQueue).stop(false).catch(() => undefined);
    if (g.__studioWebDb) await g.__studioWebDb.close();
    await dropTestDatabase(base ?? '', dbName);
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  }, 60_000);

  const stored = async () => (await observer.query<{ data: any }>(`SELECT data FROM settings WHERE id = 'default'`)).rows[0]!.data;

  /** Resolves once some other session in the test database is waiting for a row lock. */
  async function someoneWaitsForLock(): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await observer.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        [dbName],
      );
      if ((res.rows[0]?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error('no session ever waited for the settings row lock');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /** Commits the open recompute transaction once the web write is queued behind it (rolls back if it never is). */
  async function waitThenCommit(): Promise<void> {
    try {
      await someoneWaitsForLock();
    } catch (err) {
      await worker.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    await worker.query('COMMIT');
  }

  async function uploadLogo(): Promise<{ status: number; json: any }> {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(PNG)],'logo.png', { type: 'image/png' }));
    const route = await import('../src/app/api/settings/logo/route');
    const res = await (route.POST as unknown as Handler)(new NextRequest(`${ORIGIN}/api/settings/logo`, { method: 'POST', headers: { origin: ORIGIN }, body: form }), { params: Promise.resolve({}) });
    return { status: res.status, json: await res.json() };
  }

  it('keeps what the recompute learned when a logo upload starts while the job is writing', async () => {
    // The job's UPDATE has run but not committed: it holds the row lock with the new learned values.
    await worker.query('BEGIN');
    await worker.query(RECOMPUTE_SQL, [JSON.stringify(learnedValue(4)), JSON.stringify({ clean_promo: 0.8 })]);
    const upload = uploadLogo();
    // The upload must wait for the job rather than read the old settings and later write them back.
    await waitThenCommit();
    const res = await upload;
    expect(res.status).toBe(200);

    const data = await stored();
    expect(data.brand.logoStorageKey).toBe('brand/logo.png');
    expect(data.preferences.learned.eventsConsidered).toBe(4);
    expect(data.preferences.learned.fields.pacing.value).toBe('fast');
    expect(data.preferences.styleAffinity).toEqual({ clean_promo: 0.8 });
    // The response reflects the row as stored, learned values included.
    expect(res.json.settings.preferences.learned.eventsConsidered).toBe(4);
  }, 30_000);

  it('keeps what the recompute learned when it writes while a branding save holds the row', async () => {
    const { updateSettingsLocked } = await import('../src/lib/settings');
    let recompute: Promise<unknown> | null = null;
    await updateSettingsLocked(async (current) => {
      // The save has read the row under its lock; the job's UPDATE starts now and has to wait for the save to commit.
      recompute = worker.query(RECOMPUTE_SQL, [JSON.stringify(learnedValue(7)), JSON.stringify({ clean_promo: 0.2, bold_hype: 0.9 })]);
      await someoneWaitsForLock();
      return { ...current, brand: { ...current.brand, accentColour: '#224466' } };
    });
    await recompute;

    const data = await stored();
    expect(data.brand.accentColour).toBe('#224466');
    expect(data.brand.logoStorageKey).toBe('brand/logo.png');
    expect(data.preferences.learned.eventsConsidered).toBe(7);
    expect(data.preferences.styleAffinity).toEqual({ clean_promo: 0.2, bold_hype: 0.9 });
  }, 30_000);

  it('keeps what the recompute learned when the logo is removed while the job is writing', async () => {
    await worker.query('BEGIN');
    await worker.query(RECOMPUTE_SQL, [JSON.stringify(learnedValue(9)), JSON.stringify({ clean_promo: 0.5 })]);
    const route = await import('../src/app/api/settings/logo/route');
    const removal = (route.DELETE as unknown as Handler)(new NextRequest(`${ORIGIN}/api/settings/logo`, { method: 'DELETE', headers: { origin: ORIGIN } }), { params: Promise.resolve({}) });
    await waitThenCommit();
    expect((await removal).status).toBe(200);

    const data = await stored();
    expect(data.brand.logoStorageKey).toBeNull();
    expect(data.brand.accentColour).toBe('#224466');
    expect(data.preferences.learned.eventsConsidered).toBe(9);
    expect(data.preferences.styleAffinity).toEqual({ clean_promo: 0.5 });
  }, 30_000);
});
