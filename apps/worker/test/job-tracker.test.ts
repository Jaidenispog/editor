import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { CancelledError, JOB_TYPES, newId } from '@studio/core';
import { schema, type DatabaseHandle } from '@studio/db';
import { INTERRUPTED_MESSAGE, JobInterruptedError, STALE_AFTER_MS, recoverStaleJobs, runTracked } from '../src/lib/job-tracker.js';
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

  it('propagates the queue abort signal into the handler signal and reports an interruption, not a cancel', async () => {
    const boss = new AbortController();
    const bossJobId = newId();
    let ownerCancel: boolean | null = null;
    await expect(
      runTracked(
        handle.db,
        logger,
        { type: JOB_TYPES.RENDER_EXPORT, bossJobId, payload: {}, retryCount: 0, bossSignal: boss.signal, workerId: 'w1' },
        async (run) => {
          setTimeout(() => boss.abort(new CancelledError('expired')), 50);
          await new Promise<void>((resolve, reject) => run.signal.addEventListener('abort', () => reject(run.signal.reason), { once: true })).catch(async (err: unknown) => {
            ownerCancel = await run.cancelledByOwner();
            throw err;
          });
        },
      ),
    ).rejects.toBeInstanceOf(JobInterruptedError);
    expect(ownerCancel).toBe(false);
    const row = await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.bossJobId, bossJobId) });
    expect(row?.status).toBe('queued');
    expect(row?.message).toBe(INTERRUPTED_MESSAGE);
  });

  it('treats a queue abort as the owner cancel when the cancel flag is set', async () => {
    const id = newId();
    const boss = new AbortController();
    await handle.db.insert(schema.jobs).values({ id, type: JOB_TYPES.RENDER_EXPORT, payload: {}, status: 'queued' });
    await expect(
      runTracked(
        handle.db,
        logger,
        { type: JOB_TYPES.RENDER_EXPORT, bossJobId: newId(), trackingJobId: id, payload: {}, retryCount: 0, bossSignal: boss.signal, workerId: 'w1' },
        async (run) => {
          // The web app sets the flag and cancels the queue job; the queue's abort can arrive first.
          await handle.db.update(schema.jobs).set({ cancelRequested: true }).where(eq(schema.jobs.id, id));
          boss.abort(new CancelledError('cancelled in the queue'));
          expect(await run.cancelledByOwner()).toBe(true);
          run.checkCancelled();
        },
      ),
    ).rejects.toBeInstanceOf(CancelledError);
    expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) }))?.status).toBe('cancelled');
  });

  it('fails an interrupted job on its last attempt', async () => {
    const bossJobId = newId();
    const boss = new AbortController();
    await expect(
      runTracked(
        handle.db,
        logger,
        { type: JOB_TYPES.RENDER_EXPORT, bossJobId, payload: {}, retryCount: 2, bossSignal: boss.signal, workerId: 'w1' },
        async (run) => {
          expect(run.willRetry).toBe(false);
          boss.abort(new CancelledError('expired'));
          run.checkCancelled();
        },
      ),
    ).rejects.toBeInstanceOf(JobInterruptedError);
    const row = await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.bossJobId, bossJobId) });
    expect(row?.status).toBe('failed');
    expect(row?.finishedAt).not.toBeNull();
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

  it('only treats a row as stale after several missed heartbeats', async () => {
    const recent = newId();
    const lapsed = newId();
    await handle.db.insert(schema.jobs).values([
      { id: recent, type: JOB_TYPES.INGEST_ASSET, payload: {}, status: 'running', heartbeatAt: new Date(Date.now() - 20_000), bossJobId: 'boss-recent' },
      { id: lapsed, type: JOB_TYPES.INGEST_ASSET, payload: {}, status: 'running', heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 5_000), bossJobId: 'boss-lapsed' },
    ]);
    const n = await recoverStaleJobs(handle.db, logger, async () => ({ state: 'active' }));
    expect(n).toBe(1);
    expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, recent) }))?.status).toBe('running');
    const row = await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, lapsed) });
    expect(row?.status).toBe('queued');
    expect(row?.message).toMatch(/resume automatically/);
  });

  it('puts its own row back to running if a sweep marked it queued while it was still alive', async () => {
    const id = newId();
    await handle.db.insert(schema.jobs).values({ id, type: JOB_TYPES.RENDER_PREVIEW, payload: {}, status: 'queued' });
    await runTracked(
      handle.db,
      logger,
      { type: JOB_TYPES.RENDER_PREVIEW, bossJobId: newId(), trackingJobId: id, payload: {}, retryCount: 0, bossSignal: new AbortController().signal, workerId: 'w1', heartbeatMs: 40 },
      async () => {
        await handle.db.update(schema.jobs).set({ status: 'queued' }).where(eq(schema.jobs.id, id));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) }))?.status).toBe('running');
      },
    );
    expect((await handle.db.query.jobs.findFirst({ where: eq(schema.jobs.id, id) }))?.status).toBe('succeeded');
  });

  it('warns about a queue abort only while the work is still running', async () => {
    const lines: string[] = [];
    const capture = pino({ level: 'warn' }, { write: (line: string) => void lines.push(line) });
    const boss = new AbortController();
    await runTracked(
      handle.db,
      capture,
      { type: JOB_TYPES.CLEANUP, bossJobId: newId(), payload: {}, retryCount: 0, bossSignal: boss.signal, workerId: 'w1' },
      async () => 'done',
    );
    // pg-boss aborts the job signal after every normal completion; that is not worth a warning.
    boss.abort(new Error('settled'));
    expect(lines.filter((l) => l.includes('queue aborted the job'))).toHaveLength(0);

    const expired = new AbortController();
    await expect(
      runTracked(
        handle.db,
        capture,
        { type: JOB_TYPES.CLEANUP, bossJobId: newId(), payload: {}, retryCount: 0, bossSignal: expired.signal, workerId: 'w1' },
        async (run) => {
          expired.abort(new CancelledError('expired'));
          run.checkCancelled();
        },
      ),
    ).rejects.toBeInstanceOf(JobInterruptedError);
    expect(lines.filter((l) => l.includes('queue aborted the job'))).toHaveLength(1);
  });
});
