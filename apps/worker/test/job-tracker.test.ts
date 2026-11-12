import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { CancelledError, JOB_TYPES, newId } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { recoverStaleJobs, runTracked } from '../src/lib/job-tracker.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';

const logger = pino({ level: 'silent' });
const skip = !testDatabaseUrl();

describe.skipIf(skip)('runTracked', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDatabase();
    handle = t.handle;
    drop = t.drop;
  });
  afterAll(async () => {
    await drop();
  });

  it('creates the row, records progress and succeeds', async () => {
    const result = await runTracked(
      handle.db,
      logger,
      { type: JOB_TYPES.CLEANUP, bossJobId: newId(), payload: { olderThanHours: 1 }, retryCount: 0, bossSignal: new AbortController().signal, workerId: 'w1' },
      async (run) => {
        await run.progress(0.5, 'Halfway');
        return 42;
      },
    );
    expect(result).toBe(42);
    const row = await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.type, JOB_TYPES.CLEANUP) });
    expect(row?.status).toBe('succeeded');
    expect(row?.progress).toBe(1);
    expect(row?.attempts).toBe(1);
    expect(row?.workerId).toBe('w1');
  });

  it('honours an owner cancel request and marks the row cancelled', async () => {
    const id = newId();
    await handle.db.insert(schema.jobs).values({ id, type: JOB_TYPES.RENDER_PREVIEW, payload: {}, status: 'queued', cancelRequested: true });
    await expect(
      runTracked(
        handle.db,
        logger,
        { type: JOB_TYPES.RENDER_PREVIEW, bossJobId: newId(), trackingJobId: id, payload: {}, retryCount: 0, bossSignal: new AbortController().signal, workerId: 'w1' },
        async (run) => {
          run.checkCancelled();
          return 1;
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    const row = await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) });
    expect(row?.status).toBe('cancelled');
  });

  it('marks failures as retrying while attempts remain, then failed', async () => {
    const id = newId();
    await handle.db.insert(schema.jobs).values({ id, type: JOB_TYPES.INGEST_ASSET, payload: {}, status: 'queued' });
    const boom = async () => {
      throw new Error('ffmpeg exploded');
    };
    await expect(
      runTracked(handle.db, logger, { type: JOB_TYPES.INGEST_ASSET, bossJobId: newId(), trackingJobId: id, payload: {}, retryCount: 0, bossSignal: new AbortController().signal, workerId: 'w1' }, boom),
    ).rejects.toThrow('ffmpeg exploded');
    expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) }))?.status).toBe('queued');
    await expect(
      runTracked(handle.db, logger, { type: JOB_TYPES.INGEST_ASSET, bossJobId: newId(), trackingJobId: id, payload: {}, retryCount: 2, bossSignal: new AbortController().signal, workerId: 'w1' }, boom),
    ).rejects.toThrow();
    const row = await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) });
    expect(row?.status).toBe('failed');
    expect(row?.message).toMatch(/could not be processed/);
  });

  it('propagates the queue abort signal into the handler signal', async () => {
    const boss = new AbortController();
    await expect(
      runTracked(
        handle.db,
        logger,
        { type: JOB_TYPES.RENDER_EXPORT, bossJobId: newId(), payload: {}, retryCount: 0, bossSignal: boss.signal, workerId: 'w1' },
        async (run) => {
          setTimeout(() => boss.abort(new CancelledError('expired')), 50);
          await new Promise<void>((resolve, reject) => run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true }));
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('recovers stale running rows on startup', async () => {
    const stale = newId();
    const dead = newId();
    const old = new Date(Date.now() - 10 * 60_000);
    await handle.db.insert(schema.jobs).values([
      { id: stale, type: JOB_TYPES.RENDER_PREVIEW, payload: {}, status: 'running', heartbeatAt: old, bossJobId: 'boss-active' },
      { id: dead, type: JOB_TYPES.RENDER_PREVIEW, payload: {}, status: 'running', heartbeatAt: old, bossJobId: 'boss-failed' },
    ]);
    const n = await recoverStaleJobs(handle.db, logger, async (_type, bossId) => ({ state: bossId === 'boss-failed' ? 'failed' : 'retry' }));
    expect(n).toBe(2);
    expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, stale) }))?.status).toBe('queued');
    expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, dead) }))?.status).toBe('failed');
  });
});
