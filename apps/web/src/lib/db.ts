import 'server-only';
import { createDatabase, type Database, type DatabaseHandle } from '@studio/db';
import { getEnv } from './env.js';

const globalForDb = globalThis as unknown as { __studioWebDb?: DatabaseHandle };

/**
 * One pooled database connection per process. Cached on globalThis so hot reloads in development reuse the
 * pool instead of opening a new one per edit.
 */
export function getDbHandle(): DatabaseHandle {
  if (!globalForDb.__studioWebDb) {
    const env = getEnv();
    globalForDb.__studioWebDb = createDatabase(env.DATABASE_URL, { max: 10, applicationName: 'studio-web' });
  }
  return globalForDb.__studioWebDb;
}

/** Drizzle database for queries in route handlers and server components. */
export function getDb(): Database {
  return getDbHandle().db;
}
