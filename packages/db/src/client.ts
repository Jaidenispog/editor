import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Creates a pooled connection. Call once per process and share. */
export function createDatabase(connectionString: string, options: { max?: number; applicationName?: string } = {}): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
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
