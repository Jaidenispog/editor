import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { MusicClearance, MusicLicence } from '@studio/core';
import { timestamps } from './common.js';
// Circular import is safe: the references are only resolved lazily inside the callbacks below.
import { musicTracks, users } from '../schema.js';

/**
 * Tables of the music controls and licence passport module. `../schema.ts` re-exports this file, so the app, the
 * worker and drizzle-kit all see the tables.
 */

/**
 * Usage ledger (memo §2): a snapshot of a track's licence passport each time it is used. One row per version,
 * purpose and platform (exports use platform ''). No foreign key to the version: versions can be deleted with
 * their project while the ledger stays.
 */
export const musicUsage = pgTable(
  'music_usage',
  {
    id: text('id').primaryKey(),
    trackId: text('track_id')
      .notNull()
      .references(() => musicTracks.id, { onDelete: 'restrict' }),
    editVersionId: text('edit_version_id').notNull(),
    purpose: text('purpose', { enum: ['export', 'publish'] }).notNull(),
    /** '' for exports; 'instagram' | 'tiktok' | … for publishing. */
    platform: text('platform').notNull().default(''),
    licenceSnapshot: jsonb('licence_snapshot').$type<MusicLicence>().notNull(),
    clearance: jsonb('clearance').$type<MusicClearance>().notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('music_usage_version_purpose_idx').on(t.editVersionId, t.purpose, t.platform), index('music_usage_track_idx').on(t.trackId, t.createdAt)],
);

/**
 * Private Spotify references (memo §1): the canonical URL, the parsed type and id, and the owner's notes only.
 * Nothing from Spotify is fetched or cached.
 */
export const musicReferences = pgTable(
  'music_references',
  {
    id: text('id').primaryKey(),
    provider: text('provider', { enum: ['spotify'] }).notNull().default('spotify'),
    /** Canonical https://open.spotify.com/<type>/<id>. */
    url: text('url').notNull(),
    itemType: text('item_type', { enum: ['track', 'album', 'playlist', 'artist'] }).notNull(),
    /** 22-character Spotify id. */
    externalId: text('external_id').notNull(),
    notes: text('notes').notNull().default(''),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('music_references_provider_ext_idx').on(t.provider, t.itemType, t.externalId)],
);
