import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { handlePublicApi } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { getQueue } from '@/lib/queue';

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}

/** GET /api/health — liveness for monitoring: database, queue and storage driver. 503 when something is down. */
export const GET = handlePublicApi(
  async () => {
    let storage: string | null = null;
    let db = false;
    let queue = false;
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
    } catch (err) {
      getLogger().error({ err }, 'health: configuration problem');
    }
    const ok = db && queue && storage !== null;
    return NextResponse.json({ ok, db, queue, storage }, { status: ok ? 200 : 503 });
  },
  { csrf: false },
);
