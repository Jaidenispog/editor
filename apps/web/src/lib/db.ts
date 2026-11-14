import 'server-only';
import { DEFAULT_DB_POOL_MAX, createDatabase, type Database, type DatabaseHandle } from '@studio/db';
import { getEnv } from './env.js';

const globalForDb = globalThis as unknown as { __studioWebDb?: DatabaseHandle };

/**
 * One pooled database connection per process. Cached on globalThis so hot reloads in development reuse the
 * pool instead of opening a new one per edit. DB_POOL_MAX caps it (default 10; use 1 on serverless hosts).
 */
export function getDbHandle(): DatabaseHandle {
  if (!globalForDb.__studioWebDb) {
    const env = getEnv();
    globalForDb.__studioWebDb = createDatabase(env.DATABASE_URL, { max: env.DB_POOL_MAX ?? DEFAULT_DB_POOL_MAX.web, applicationName: 'studio-web' });
  }
  return globalForDb.__studioWebDb;
}

/** Drizzle database for queries in route handlers and server components. */
export function getDb(): Database {
  return getDbHandle().db;
}
