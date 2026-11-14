import pg from 'pg';

/**
 * Drops a throwaway test database once the app's pools have really let go of it.
 *
 * `pg.Pool#end()` resolves as soon as its idle clients are asked to close, before their sockets are gone. Dropping
 * the database `WITH (FORCE)` straight away then terminates those half-closed connections, and the server's
 * "terminating connection" notice reaches a client that no longer has an error listener, which vitest reports as an
 * unhandled error. Waiting (briefly) until no other session uses the database avoids that race; FORCE remains the
 * fallback for anything still connected after the wait.
 */
export async function dropTestDatabase(adminUrl: string, dbName: string, waitMs = 5_000): Promise<void> {
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
