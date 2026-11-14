/**
 * The worker heartbeat on a real database: the worker writes its row, the web app's read (`readWorkerStatus`)
 * applies the 60 s staleness rule against the database clock, and a graceful stop removes the row. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { WORKER_STALE_AFTER_MS, isHeartbeatFresh, pruneWorkerHeartbeats, readWorkerStatus, recordWorkerHeartbeat, removeWorkerHeartbeat, schema, type DatabaseHandle } from '@studio/db';
import { startWorkerHeartbeat } from '../src/lib/worker-heartbeat.js';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';

const skip = !testDatabaseUrl();
const quietLogger = { warn: () => {}, info: () => {} };

describe('isHeartbeatFresh (the staleness rule)', () => {
  const now = new Date('2026-11-14T10:00:00Z');
  it('is alive up to 60 s after the last heartbeat and not after', () => {
    expect(WORKER_STALE_AFTER_MS).toBe(60_000);
    expect(isHeartbeatFresh(new Date(now.getTime() - 15_000), now)).toBe(true);
    expect(isHeartbeatFresh(new Date(now.getTime() - 60_000), now)).toBe(true);
    expect(isHeartbeatFresh(new Date(now.getTime() - 60_001), now)).toBe(false);
    expect(isHeartbeatFresh(null, now)).toBe(false);
  });
});

describe.skipIf(skip)('worker heartbeat (database-backed)', () => {
  let handle: DatabaseHandle;
  let drop: () => Promise<void>;
  const info = (id: string) => ({ id, hostname: 'test-host', pid: 4242, version: '0.1.0', queues: ['ingest.asset', 'render.preview'] });
  const ageRow = (id: string, seconds: number) =>
    handle.db
      .update(schema.workerHeartbeats)
      .set({ lastSeenAt: sql`now() - make_interval(secs => ${seconds})` })
      .where(eq(schema.workerHeartbeats.id, id));

  beforeAll(async () => {
    ({ handle, drop } = await createTestDatabase());
  });
  afterAll(async () => {
    await drop?.();
  });

  it('reports no worker before any heartbeat', async () => {
    expect(await readWorkerStatus(handle.db)).toEqual({ alive: false, lastSeenAt: null });
  });

  it('a fresh heartbeat is alive; 59 s old is still alive; 61 s old is not', async () => {
    await recordWorkerHeartbeat(handle.db, info('w1'));
    const fresh = await readWorkerStatus(handle.db);
    expect(fresh.alive).toBe(true);
    expect(fresh.lastSeenAt).toBeInstanceOf(Date);

    await ageRow('w1', 59);
    expect((await readWorkerStatus(handle.db)).alive).toBe(true);

    await ageRow('w1', 61);
    const stale = await readWorkerStatus(handle.db);
    expect(stale.alive).toBe(false);
    // The app can still say when it was last seen.
    expect(stale.lastSeenAt).toBeInstanceOf(Date);

    // A new beat from the same worker refreshes the same row.
    await recordWorkerHeartbeat(handle.db, info('w1'));
    expect((await readWorkerStatus(handle.db)).alive).toBe(true);
    const rows = await handle.db.select().from(schema.workerHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'w1', hostname: 'test-host', pid: 4242, queues: ['ingest.asset', 'render.preview'] });
  });

  it('one live worker is enough when another one died', async () => {
    await ageRow('w1', 300);
    await recordWorkerHeartbeat(handle.db, info('w2'));
    expect((await readWorkerStatus(handle.db)).alive).toBe(true);
    await removeWorkerHeartbeat(handle.db, 'w2');
    expect((await readWorkerStatus(handle.db)).alive).toBe(false);
  });

  it('prunes rows of workers not seen for a day', async () => {
    await ageRow('w1', 2 * 24 * 3600);
    await recordWorkerHeartbeat(handle.db, info('w3'));
    expect(await pruneWorkerHeartbeats(handle.db)).toBe(1);
    const ids = (await handle.db.select({ id: schema.workerHeartbeats.id }).from(schema.workerHeartbeats)).map((r) => r.id);
    expect(ids).toEqual(['w3']);
    await removeWorkerHeartbeat(handle.db, 'w3');
  });

  it('startWorkerHeartbeat writes at once, keeps beating and removes the row on stop', async () => {
    const hb = await startWorkerHeartbeat(handle.db, info('w4'), quietLogger, 50);
    expect((await readWorkerStatus(handle.db)).alive).toBe(true);
    await ageRow('w4', 120);
    expect((await readWorkerStatus(handle.db)).alive).toBe(false);
    // The next beat (50 ms here, 15 s in the worker) makes it alive again.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await readWorkerStatus(handle.db)).alive).toBe(true);
    await hb.stop();
    expect(await readWorkerStatus(handle.db)).toEqual({ alive: false, lastSeenAt: null });
  });
});
