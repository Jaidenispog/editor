import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { newId } from '@studio/core';
import type { Database } from './client.js';
import * as schema from './schema.js';

/** What {@link purgeSquareData} removed. */
export interface SquarePurgeResult {
  bookings: number;
  customers: number;
  availabilitySearches: number;
}

/** A database or an open transaction. */
type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/** Optional tables of later packages that are purged with Square data when they exist (WP6b's booking changes). */
const OPTIONAL_TABLES = ['square_booking_changes'] as const;

/**
 * Removes Square data copied into Studio Assistant, in one transaction: availability searches and bookings of the
 * environment are deleted; customers of the environment are always scrubbed, never deleted (names, contact details
 * and the Square id cleared, `deleted_at` set), because other modules' rows (email messages, review requests,
 * consent events) may point at them and their suppressions are keyed by email. Pass no environment to remove every
 * environment's data (a different Square account). Writes the `integration.square.data_purged` audit entry.
 */
export async function purgeSquareData(
  db: Executor,
  options: { environment?: 'sandbox' | 'production' | null; userId?: string | null; reason?: string; now?: Date } = {},
): Promise<SquarePurgeResult> {
  const now = options.now ?? new Date();
  const env = options.environment ?? null;
  const work = async (tx: Executor): Promise<SquarePurgeResult> => {
    for (const table of OPTIONAL_TABLES) {
      const exists = await tx.execute(sql`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`);
      if ((exists.rows[0] as { present?: boolean } | undefined)?.present) {
        await tx.execute(env ? sql`DELETE FROM ${sql.identifier(table)} WHERE environment = ${env}` : sql`DELETE FROM ${sql.identifier(table)}`);
      }
    }
    const s = schema.squareAvailabilitySearches;
    const searches = await tx.delete(s).where(env ? eq(s.environment, env) : undefined).returning({ id: s.id });
    const b = schema.bookings;
    const bookings = await tx.delete(b).where(env ? eq(b.squareEnvironment, env) : undefined).returning({ id: b.id });
    const c = schema.customers;
    const scope = env ? eq(c.squareEnvironment, env) : isNotNull(c.squareEnvironment);
    const ids = (await tx.select({ id: c.id }).from(c).where(and(scope, isNotNull(c.squareCustomerId)))).map((r) => r.id);
    if (ids.length) {
      await tx
        .update(c)
        .set({ squareCustomerId: null, givenName: '', familyName: '', email: null, phone: null, squareEmailUnsubscribed: null, deletedAt: now, updatedAt: now })
        .where(inArray(c.id, ids));
    }
    const result = { bookings: bookings.length, customers: ids.length, availabilitySearches: searches.length };
    await tx.insert(schema.auditLog).values({
      id: newId(),
      userId: options.userId ?? null,
      action: 'integration.square.data_purged',
      entityType: 'integration_connection',
      entityId: null,
      data: { environment: env ?? 'all', reason: options.reason ?? '', bookings: result.bookings, customers: result.customers },
    });
    return result;
  };
  // A transaction (or a savepoint when the caller already holds one), so a failure leaves nothing half purged.
  return (db as Database).transaction((tx) => work(tx));
}

/**
 * Scrubs one customer Square deleted (the same scrub as {@link purgeSquareData}, for a single row). Returns true when
 * a row was scrubbed.
 */
export async function scrubSquareCustomer(db: Executor, squareCustomerId: string, now: Date = new Date()): Promise<boolean> {
  const c = schema.customers;
  const rows = await db
    .update(c)
    .set({ squareCustomerId: null, givenName: '', familyName: '', email: null, phone: null, squareEmailUnsubscribed: null, deletedAt: now, updatedAt: now })
    .where(eq(c.squareCustomerId, squareCustomerId))
    .returning({ id: c.id });
  return rows.length > 0;
}
