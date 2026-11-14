import { bigint, date, index, integer, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Tables of the website check and Search Console module (WP8). `website_audits` and `website_edits` predate the
 * module registry and stay in `../schema.ts`; this file re-exported there, so the app, the worker and drizzle-kit see
 * every table.
 */

/**
 * Numbers Google returned, one row per (source, property, day or month, kind, key). Nothing is estimated or filled
 * in: a missing value stays NULL and is shown as "—". Upserted on the unique index, so a re-run gives identical rows.
 */
export const searchMetrics = pgTable(
  'search_metrics',
  {
    id: text('id').primaryKey(),
    /** `search_console` | `business_profile`. */
    source: text('source', {
      enum: ['search_console', 'business_profile'],
    }).notNull(),
    /** Search Console `siteUrl`, or a Business Profile `locations/{id}`. */
    property: text('property').notNull(),
    granularity: text('granularity', { enum: ['day', 'month'] }).notNull(),
    /** The day, or the first day of the month (as Google dates them). */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    /** `total` | `query` | `metric` | `keyword`. */
    kind: text('kind', {
      enum: ['total', 'query', 'metric', 'keyword'],
    }).notNull(),
    /** Query text, metric name or keyword; '' for totals. */
    key: text('key').notNull().default(''),
    clicks: integer('clicks'),
    impressions: integer('impressions'),
    /** Search Console average position for this row. */
    position: real('position'),
    /** Business Profile metric or keyword value. */
    value: bigint('value', { mode: 'number' }),
    /** Business Profile keyword reported only as "fewer than N". */
    valueThreshold: bigint('value_threshold', { mode: 'number' }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('search_metrics_row_idx').on(t.source, t.property, t.granularity, t.periodStart, t.kind, t.key),
    index('search_metrics_lookup_idx').on(t.source, t.property, t.kind, t.periodStart),
  ],
);
