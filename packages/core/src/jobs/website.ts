import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the website check and Search Console module (WP8). */
export const WEBSITE_JOB_TYPES = {
  /** Reads up to 25 pages of the owner's confirmed site and stores findings and prepared changes. Never changes the site. */
  WEBSITE_AUDIT: 'website.audit',
  /** Applies one owner-approved change through the connected WordPress site, then reads it back. */
  WEBSITE_EDIT_APPLY: 'website.edit_apply',
  /** Asks the AI for up to three wording options for one change (only on the owner's click). */
  WEBSITE_COPY_DRAFT: 'website.copy_draft',
  /** Read-only connection check: Search Console properties or the WordPress user's rights. Never writes anywhere. */
  WEBSITE_CONNECTION_CHECK: 'website.connection_check',
  /** Fetches Search Console numbers into `search_metrics` (idempotent upserts). */
  SEARCH_SYNC: 'search.sync',
} as const;

/** `website.audit`: one queued check. */
export const WebsiteAuditPayloadSchema = z.object({
  auditId: z.string().min(1),
});
/** `website.edit_apply`: one approved change. */
export const WebsiteEditApplyPayloadSchema = z.object({
  editId: z.string().min(1),
});
/** `website.copy_draft`: one change to suggest wording for. */
export const WebsiteCopyDraftPayloadSchema = z.object({
  editId: z.string().min(1),
});
/**
 * `website.connection_check`: which connection to check and why. The Business Profile performance probe is added by
 * the Business Profile package (WP9) as a backwards-compatible enum value.
 */
export const WebsiteConnectionCheckPayloadSchema = z.object({
  provider: z.enum(['google_search_console', 'website']),
  reason: z.enum(['connect', 'manual', 'daily']).default('manual'),
});
/** `search.sync`: which source and why (`connect` backfills 16 months; `daily`/`manual` re-fetch the last 10 days). */
export const SearchSyncPayloadSchema = z.object({
  source: z.enum(['search_console']),
  reason: z.enum(['connect', 'daily', 'manual']).default('daily'),
});
export type WebsiteConnectionCheckPayload = z.infer<typeof WebsiteConnectionCheckPayloadSchema>;
export type SearchSyncPayload = z.infer<typeof SearchSyncPayloadSchema>;

/** Payload schemas of the website check and Search Console module's job types, keyed by job type. */
export const WEBSITE_JOB_PAYLOAD_SCHEMAS = {
  [WEBSITE_JOB_TYPES.WEBSITE_AUDIT]: WebsiteAuditPayloadSchema,
  [WEBSITE_JOB_TYPES.WEBSITE_EDIT_APPLY]: WebsiteEditApplyPayloadSchema,
  [WEBSITE_JOB_TYPES.WEBSITE_COPY_DRAFT]: WebsiteCopyDraftPayloadSchema,
  [WEBSITE_JOB_TYPES.WEBSITE_CONNECTION_CHECK]: WebsiteConnectionCheckPayloadSchema,
  [WEBSITE_JOB_TYPES.SEARCH_SYNC]: SearchSyncPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
