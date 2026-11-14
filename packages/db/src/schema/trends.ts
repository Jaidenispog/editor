import { boolean, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { TrendWatchProvider, TrendWatchStatus } from '@studio/core';
import { socialAccounts, users } from '../schema.js';
import { timestamps } from './common.js';

/**
 * Tables of the trends module (WP3; WP5 uses the same table for the Instagram hashtag watch). `../schema.ts`
 * re-exports this file, so the app, the worker and drizzle-kit all see the tables.
 */

/**
 * One row per live source query the owner turned on (the YouTube AU popular chart; later Instagram hashtags).
 * Removing a watch sets `enabled = false` and deletes its items, but the row stays for 7 days so the Instagram
 * hashtag budget (30 distinct hashtags per rolling 7 days) stays correct; `maintenance.cleanup` then deletes it.
 */
export const trendWatches = pgTable(
  'trend_watches',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<TrendWatchProvider>().notNull(),
    /** Hashtag (lower case, no `#`) or the region code `AU` for the YouTube chart. */
    query: text('query').notNull(),
    /** Instagram hashtag id once resolved. */
    externalId: text('external_id'),
    /** Instagram only: the professional account the hashtag is searched as. */
    socialAccountId: text('social_account_id').references(() => socialAccounts.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status').$type<TrendWatchStatus>().notNull().default('pending'),
    /** Plain message for the owner about the last outcome ('' when all is well). */
    statusMessage: text('status_message').notNull().default(''),
    /** Set just before each external call; counts towards the hashtag budget. */
    lastQueriedAt: timestamp('last_queried_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('trend_watches_provider_query_idx').on(t.provider, t.query)],
);

export type TrendWatch = typeof trendWatches.$inferSelect;
