import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { handlePublicApi } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getQueue } from '@/lib/queue';
import { getWorkerStatus } from '@/lib/worker-status';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}

/**
 * GET /api/health — liveness for monitoring: database, queue and storage driver. 503 when something the web app
 * itself needs is down. `worker` reports the background worker's heartbeat (alive when it was seen in the last
 * 60 s) for information only: a stopped worker never turns this into a 503, because the web app still works.
 */
export const GET = handlePublicApi(
  async () => {
    let storage: string | null = null;
    let db = false;
    let queue = false;
    let worker: { alive: boolean; lastSeenAt: string | null } = { alive: false, lastSeenAt: null };
    try {
      storage = getEnv().STORAGE_DRIVER;
      db = await withTimeout(getDb().execute(sql`select 1`), 3000).then(
        () => true,
        (err: unknown) => {
          getLogger().warn({ err }, 'health: database check failed');
          return false;
        },
      );
      queue = await withTimeout(getQueue(), 5000).then(
        () => true,
        (err: unknown) => {
          getLogger().warn({ err }, 'health: queue check failed');
          return false;
        },
      );
      if (db) {
        worker = await withTimeout(getWorkerStatus(), 3000).then(
          (w) => ({ alive: w.alive, lastSeenAt: w.lastSeenAt }),
          () => ({ alive: false, lastSeenAt: null }),
        );
      }
    } catch (err) {
      getLogger().error({ err }, 'health: configuration problem');
    }
    const ok = db && queue && storage !== null;
    return NextResponse.json({ ok, db, queue, storage, worker }, { status: ok ? 200 : 503 });
  },
  { csrf: false },
);
