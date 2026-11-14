import { eq, sql } from 'drizzle-orm';
import type { Env } from '@studio/config';
import type { ConnectionCapabilities, ConnectionProvider, ConnectionStatus } from '@studio/core';
import { schema, type Database } from '@studio/db';
import { encryptCredential } from './credentials.js';

/** One `integration_connections` row. */
export type ConnectionRow = typeof schema.integrationConnections.$inferSelect;
/** An open transaction, as Drizzle passes it to `db.transaction`. */
export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Reads a provider's connection row (one per provider), or null. */
export async function loadConnection(db: Database | DbTransaction, provider: ConnectionProvider): Promise<ConnectionRow | null> {
  const rows = await db.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, provider)).limit(1);
  return rows[0] ?? null;
}

/**
 * Runs `fn` in a transaction holding `SELECT … FOR UPDATE` on the provider's row, so two jobs never refresh the same
 * token at once or overwrite each other's result. The second caller waits, then sees the first one's update.
 * Keep the work short: the row stays locked until `fn` returns.
 */
export async function withConnectionLock<T>(db: Database, provider: ConnectionProvider, fn: (tx: DbTransaction, conn: ConnectionRow | null) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, provider)).limit(1).for('update');
    return fn(tx, rows[0] ?? null);
  });
}

/** New tokens returned by a provider's refresh call. */
export interface RefreshedTokens {
  accessToken: string;
  /** A rotated refresh token, when the provider sends one; undefined keeps the stored one. */
  refreshToken?: string | null | undefined;
  expiresAt: Date | null;
  scopes?: string[] | undefined;
}

/** Calls the provider to refresh a connection's tokens (provider rules stay in each module). */
export type TokenRefresher = (conn: ConnectionRow) => Promise<RefreshedTokens>;

/**
 * Refreshes the connection's access token when it expires within `skewSeconds` (or its expiry is unknown), storing
 * the new tokens encrypted. Call it inside {@link withConnectionLock} with the locked row.
 */
export async function refreshIfExpiring(
  tx: DbTransaction,
  env: Pick<Env, 'APP_SECRET' | 'APP_ENCRYPTION_KEY'>,
  conn: ConnectionRow,
  skewSeconds: number,
  refresher: TokenRefresher,
  now: Date = new Date(),
): Promise<{ conn: ConnectionRow; refreshed: boolean }> {
  if (conn.accessTokenEncrypted && conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - now.getTime() > skewSeconds * 1000) {
    return { conn, refreshed: false };
  }
  const tokens = await refresher(conn);
  const updated = await tx
    .update(schema.integrationConnections)
    .set({
      accessTokenEncrypted: encryptCredential(env, tokens.accessToken),
      ...(tokens.refreshToken ? { refreshTokenEncrypted: encryptCredential(env, tokens.refreshToken) } : {}),
      tokenExpiresAt: tokens.expiresAt,
      ...(tokens.scopes ? { scopes: tokens.scopes } : {}),
      updatedAt: now,
    })
    .where(eq(schema.integrationConnections.id, conn.id))
    .returning();
  return { conn: updated[0] ?? conn, refreshed: true };
}

/** The outcome of a read-only capability check. */
export interface ConnectionCheckResult {
  status: ConnectionStatus;
  /** Merged into the stored capabilities (keys not mentioned are kept). */
  capabilities?: ConnectionCapabilities;
  /** Plain message for the owner, or null to clear it. */
  lastError?: string | null;
  displayName?: string;
}

/**
 * Records a read-only check's outcome on the provider's row: status, merged capabilities, last error and the check
 * time. Returns the updated row, or null when the provider has no row (nothing is created).
 */
export async function recordConnectionCheck(db: Database | DbTransaction, provider: ConnectionProvider, result: ConnectionCheckResult, now: Date = new Date()): Promise<ConnectionRow | null> {
  const t = schema.integrationConnections;
  const rows = await db
    .update(t)
    .set({
      status: result.status,
      ...(result.capabilities ? { capabilities: sql`${t.capabilities} || ${JSON.stringify(result.capabilities)}::jsonb` } : {}),
      ...(result.lastError !== undefined ? { lastError: result.lastError ? result.lastError.slice(0, 500) : null } : {}),
      ...(result.displayName !== undefined ? { displayName: result.displayName } : {}),
      lastSyncAt: now,
      updatedAt: now,
    })
    .where(eq(t.provider, provider))
    .returning();
  return rows[0] ?? null;
}
