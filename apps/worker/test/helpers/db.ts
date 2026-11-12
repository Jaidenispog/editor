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
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await c.end();
    },
  };
}
