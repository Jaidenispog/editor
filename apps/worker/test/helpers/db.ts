import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, runMigrations, type DatabaseHandle } from '@studio/db';

/**
 * Creates a throwaway database for one test file on the Postgres instance named by TEST_DATABASE_URL
 * (falls back to DATABASE_URL). Tests are skipped when neither is set.
 */
export function testDatabaseUrl(): string | null {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
}

export async function createTestDatabase(): Promise<{ handle: DatabaseHandle; url: string; drop: () => Promise<void> }> {
  const base = testDatabaseUrl();
  if (!base) throw new Error('TEST_DATABASE_URL is not set');
  const name = `sa_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(base);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());
  const handle = createDatabase(url.toString(), { max: 4, applicationName: 'studio-test' });
  return {
    handle,
    url: url.toString(),
    drop: async () => {
      await handle.close();
      await dropWhenIdle(base, name);
    },
  };
}

/**
 * Drops the database once the pool has really let go of it. `handle.close()` resolves before the idle sockets are
 * gone; dropping `WITH (FORCE)` straight away terminates those half-closed connections, and the server's
 * "terminating connection" notice (57P01) reaches a client with no error listener, which vitest reports as an
 * unhandled error in an unrelated test. Wait briefly for other sessions to leave; FORCE stays as the fallback.
 */
async function dropWhenIdle(adminUrl: string, dbName: string, waitMs = 5_000): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const res = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
      if ((res.rows[0]?.n ?? 0) === 0 || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
