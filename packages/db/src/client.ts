import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Default app-query pool size per process, used when DB_POOL_MAX is not set. Lower both on small hosted databases
 * (see the Supabase Micro budget in docs/deployment.md).
 */
export const DEFAULT_DB_POOL_MAX = { web: 10, worker: 8 } as const;

/** Options for createDatabase. */
export interface DatabaseOptions {
  /** Largest number of connections the pool opens (DB_POOL_MAX). Defaults to 10. */
  max?: number | undefined;
  applicationName?: string | undefined;
}

/** Creates a pooled connection. Call once per process and share. */
export function createDatabase(connectionString: string, options: DatabaseOptions = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? DEFAULT_DB_POOL_MAX.web,
    application_name: options.applicationName ?? 'studio-assistant',
    // Supabase and most managed providers require TLS; local Postgres does not advertise it.
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

/**
 * Opens one short-lived connection and runs `select 1`, so a caller can tell "the database is not up yet" from a
 * real problem before it starts anything else. Rejects with the driver's error (codes such as ECONNREFUSED or
 * 57P03 are kept); a connection that takes longer than `timeoutMs` rejects with an ETIMEDOUT error.
 */
export async function probeDatabase(connectionString: string, options: { timeoutMs?: number; applicationName?: string } = {}): Promise<void> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: options.timeoutMs ?? 10_000,
    application_name: options.applicationName ?? 'studio-probe',
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  // A failed connect can also emit 'error'; without a listener that would crash the process.
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('select 1');
  } catch (err) {
    if (err instanceof Error && /timeout/i.test(err.message) && !(err as { code?: string }).code) Object.assign(err, { code: 'ETIMEDOUT' });
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

function needsSsl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get('sslmode') === 'disable') return false;
    if (url.searchParams.get('sslmode')) return true;
    const host = url.hostname;
    return !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local') || host === 'postgres' || host === 'db');
  } catch {
    return false;
  }
}

export { schema };
