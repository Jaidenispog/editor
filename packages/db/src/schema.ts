import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  bigint,
} from 'drizzle-orm/pg-core';
import type {
  AppSettings,
  AssetAnalysis,
  AssetProbe,
  EditPlan,
  GenerationSettings,
  MusicLicence,
  PlanIssue,
  StyleSupport,
} from '@studio/core';
import { timestamps } from './schema/common.js';
import { trendWatches } from './schema/trends.js';

// New Stage B/C tables live in one file per module (./schema/<module>.ts) and are re-exported here, so the app,
// the worker and drizzle-kit all see them while parallel work packages edit only their own file.
export * from './schema/music.js';
export * from './schema/preferences.js';
export * from './schema/trends.js';
export * from './schema/publishing.js';
export * from './schema/square.js';
export * from './schema/email.js';
export * from './schema/website.js';
export * from './schema/business_profile.js';

// ---------------------------------------------------------------------------------------------
// Identity & access
// ---------------------------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['owner', 'staff'] }).notNull().default('staff'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_idx').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 of the cookie token; the raw token never touches the database. */
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent').notNull().default(''),
    ipAddress: text('ip_address').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: text('id').primaryKey(),
    emailLower: text('email_lower').notNull(),
    ipAddress: text('ip_address').notNull().default(''),
    succeeded: boolean('succeeded').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('login_attempts_email_time_idx').on(t.emailLower, t.createdAt), index('login_attempts_ip_time_idx').on(t.ipAddress, t.createdAt)],
);

/** Single-row table (id = 'default') holding brand, business and editing preferences. */
export const settings = pgTable('settings', {
  id: text('id').primaryKey(),
  data: jsonb('data').$type<AppSettings>().notNull(),
  ...timestamps,
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId), index('audit_log_created_idx').on(t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Video studio
// ---------------------------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    clientName: text('client_name').notNull().default(''),
    notes: text('notes').notNull().default(''),
    status: text('status', { enum: ['draft', 'analysing', 'ready', 'generating', 'complete', 'archived'] })
      .notNull()
      .default('draft'),
    /** Last chosen generation settings so the form remembers them. */
    lastSettings: jsonb('last_settings').$type<GenerationSettings | null>(),
    /** Cached per-style support computed after analysis. */
    styleSupport: jsonb('style_support').$type<StyleSupport[] | null>(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('projects_owner_idx').on(t.ownerId, t.createdAt), index('projects_deleted_idx').on(t.deletedAt)],
);

export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: ['video', 'audio', 'image', 'reference_video'] }).notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    partSizeBytes: integer('part_size_bytes').notNull(),
    partCount: integer('part_count').notNull(),
    receivedParts: jsonb('received_parts').$type<number[]>().notNull().default([]),
    /** Storage-driver specific state (e.g. S3 multipart upload id and ETags). */
    driverState: jsonb('driver_state').$type<Record<string, unknown>>().notNull().default({}),
    targetKey: text('target_key').notNull(),
    status: text('status', { enum: ['open', 'completed', 'aborted', 'expired'] }).notNull().default('open'),
    assetId: text('asset_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index('upload_sessions_project_idx').on(t.projectId), index('upload_sessions_status_idx').on(t.status, t.expiresAt)],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['video', 'audio', 'image', 'reference_video'] }).notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    /** Position chosen by the owner (upload order by default). */
    sortOrder: integer('sort_order').notNull().default(0),
    originalKey: text('original_key').notNull(),
    proxyKey: text('proxy_key'),
    thumbnailKey: text('thumbnail_key'),
    status: text('status', { enum: ['uploaded', 'processing', 'ready', 'failed'] }).notNull().default('uploaded'),
    statusMessage: text('status_message').notNull().default(''),
    probe: jsonb('probe').$type<AssetProbe | null>(),
    analysis: jsonb('analysis').$type<AssetAnalysis | null>(),
    /** Owner-applied shot labels: { [shotId]: label }. Manual labels override the model. */
    manualLabels: jsonb('manual_labels').$type<Record<string, string>>().notNull().default({}),
    /** Owner can tag a whole clip (applied to all its shots). */
    clipLabel: text('clip_label'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('media_assets_project_idx').on(t.projectId, t.sortOrder), index('media_assets_status_idx').on(t.status)],
);

export const musicTracks = pgTable(
  'music_tracks',
  {
    id: text('id').primaryKey(),
    /** Null = available to every project (library track); otherwise scoped to one project. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    artist: text('artist').notNull().default(''),
    source: text('source', { enum: ['upload', 'catalogue'] }).notNull().default('upload'),
    catalogueProvider: text('catalogue_provider'),
    catalogueTrackId: text('catalogue_track_id'),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    durationSec: real('duration_sec'),
    bpm: real('bpm'),
    /** Beat timestamps (seconds) and an energy curve for the picker UI. */
    beats: jsonb('beats').$type<{ beatTimesSec: number[]; energy: number[]; energyStepSec: number } | null>(),
    moods: jsonb('moods').$type<string[]>().notNull().default([]),
    licence: jsonb('licence').$type<MusicLicence>().notNull(),
    status: text('status', { enum: ['uploaded', 'processing', 'ready', 'failed'] }).notNull().default('uploaded'),
    statusMessage: text('status_message').notNull().default(''),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('music_tracks_project_idx').on(t.projectId), index('music_tracks_status_idx').on(t.status)],
);

/** One press of "Generate 5 edits". */
export const generations = pgTable(
  'generations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by')
      .notNull()
      .references(() => users.id),
    settings: jsonb('settings').$type<GenerationSettings>().notNull(),
    status: text('status', { enum: ['queued', 'planning', 'rendering', 'complete', 'partial', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    statusMessage: text('status_message').notNull().default(''),
    plannerUsed: text('planner_used'),
    ...timestamps,
  },
  (t) => [index('generations_project_idx').on(t.projectId, t.createdAt)],
);

/** One of the five edits in a generation; its versions hold the actual plans and renders. */
export const edits = pgTable(
  'edits',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    generationId: text('generation_id')
      .notNull()
      .references(() => generations.id, { onDelete: 'cascade' }),
    styleId: text('style_id').notNull(),
    slot: integer('slot').notNull(),
    isFavourite: boolean('is_favourite').notNull().default(false),
    currentVersionId: text('current_version_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('edits_project_idx').on(t.projectId), index('edits_generation_idx').on(t.generationId, t.slot)],
);

export const editVersions = pgTable(
  'edit_versions',
  {
    id: text('id').primaryKey(),
    editId: text('edit_id')
      .notNull()
      .references(() => edits.id, { onDelete: 'cascade' }),
    versionNo: integer('version_no').notNull(),
    parentVersionId: text('parent_version_id'),
    /** 'initial' for generation output, 'revise' for instruction-driven, 'regenerate' for a fresh take. */
    origin: text('origin', { enum: ['initial', 'revise', 'regenerate'] }).notNull(),
    instruction: text('instruction').notNull().default(''),
    planSource: text('plan_source', { enum: ['ai', 'rules', 'manual'] }),
    plannerModel: text('planner_model'),
    plan: jsonb('plan').$type<EditPlan | null>(),
    validation: jsonb('validation').$type<{ ok: boolean; errors: PlanIssue[]; warnings: PlanIssue[] } | null>(),
    status: text('status', { enum: ['planning', 'planned', 'rendering_preview', 'preview_ready', 'failed', 'cancelled'] })
      .notNull()
      .default('planning'),
    statusMessage: text('status_message').notNull().default(''),
    previewKey: text('preview_key'),
    previewDurationSec: real('preview_duration_sec'),
    exportStatus: text('export_status', { enum: ['none', 'queued', 'rendering', 'ready', 'failed'] }).notNull().default('none'),
    exportKey: text('export_key'),
    exportByteSize: bigint('export_byte_size', { mode: 'number' }),
    exportMessage: text('export_message').notNull().default(''),
    ...timestamps,
  },
  (t) => [uniqueIndex('edit_versions_edit_no_idx').on(t.editId, t.versionNo), index('edit_versions_status_idx').on(t.status)],
);

/** Owner feedback used to learn preferences (no model training). */
export const feedbackEvents = pgTable(
  'feedback_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    editId: text('edit_id'),
    editVersionId: text('edit_version_id'),
    styleId: text('style_id'),
    type: text('type', { enum: ['favourite', 'unfavourite', 'download', 'revise', 'regenerate', 'publish', 'dismiss'] }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('feedback_events_style_idx').on(t.styleId, t.type)],
);

/** Mirror of queue jobs for the UI: progress, messages and cooperative cancellation. */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** The main entity this job works on (asset id, edit version id, track id, generation id). */
    refId: text('ref_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] }).notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    message: text('message').notNull().default(''),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    bossJobId: text('boss_job_id'),
    workerId: text('worker_id'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('jobs_project_idx').on(t.projectId, t.createdAt), index('jobs_status_idx').on(t.status, t.heartbeatAt), index('jobs_ref_idx').on(t.refId)],
);

export const aiUsage = pgTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    purpose: text('purpose').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** Estimated cost in USD cents at the configured rates (informational). */
    estimatedCostUsdCents: real('estimated_cost_usd_cents').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);

export const trendReferences = pgTable(
  'trend_references',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    category: text('category', { enum: ['format', 'sound', 'hook', 'text_style', 'pacing', 'other'] }).notNull().default('format'),
    sourceName: text('source_name').notNull(),
    sourceUrl: text('source_url').notNull().default(''),
    /**
     * 'curated' = hand-maintained reference; 'live' = fetched from an official API by a trend watch; 'noted' = something
     * a staff member saw themselves ("Note a trend"). The three are never mixed in one list.
     */
    sourceKind: text('source_kind', { enum: ['curated', 'live', 'noted'] }).notNull().default('curated'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Live items: the watch that fetched them (deleted with it). */
    watchId: text('watch_id').references(() => trendWatches.id, { onDelete: 'cascade' }),
    /** Live items: the YouTube video id (or Instagram media id). */
    externalId: text('external_id'),
    /** Live items: when this item was fetched (shown as "fetched <date>"). */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    /** Live items: after this the item shows "Out of date". */
    staleAfter: timestamp('stale_after', { withTimezone: true }),
    /** Live item fields, a noted trend's platform and date, or a curated reference's list of sources. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** Noted trends: who noted it. */
    notedBy: text('noted_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('trend_references_enabled_idx').on(t.enabled, t.category),
    // Idempotent refreshes: one row per item per watch.
    uniqueIndex('trend_references_watch_ext_idx').on(t.watchId, t.externalId).where(sql`${t.externalId} is not null`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Publishing (Stage B)
// ---------------------------------------------------------------------------------------------

export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: text('id').primaryKey(),
    platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
    externalId: text('external_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull().default(''),
    /** Encrypted at rest (AES-256-GCM, packages/db/src/crypto.ts). */
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
    status: text('status', { enum: ['connected', 'needs_reauth', 'disconnected'] }).notNull().default('connected'),
    ...timestamps,
  },
  (t) => [uniqueIndex('social_accounts_platform_ext_idx').on(t.platform, t.externalId)],
);

export const publishPosts = pgTable(
  'publish_posts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    editVersionId: text('edit_version_id').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id),
    caption: text('caption').notNull().default(''),
    coverTimeSec: real('cover_time_sec'),
    coverKey: text('cover_key'),
    mode: text('mode', { enum: ['now', 'scheduled', 'draft_handoff'] }).notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    musicCheck: jsonb('music_check').$type<{ ok: boolean; reasons: string[] } | null>(),
    status: text('status', { enum: ['draft', 'approved', 'in_progress', 'complete', 'partial', 'failed', 'cancelled'] })
      .notNull()
      .default('draft'),
    ...timestamps,
  },
  (t) => [index('publish_posts_status_idx').on(t.status, t.scheduledFor)],
);

export const publishTargets = pgTable(
  'publish_targets',
  {
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => publishPosts.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => socialAccounts.id),
    platform: text('platform', { enum: ['instagram', 'tiktok'] }).notNull(),
    /** Key used to make retries idempotent against the platform (e.g. container id / publish id). */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', { enum: ['queued', 'processing', 'published', 'failed', 'manual_step_required', 'cancelled'] })
      .notNull()
      .default('queued'),
    externalContainerId: text('external_container_id'),
    externalPostId: text('external_post_id'),
    publishedUrl: text('published_url'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('publish_targets_post_account_idx').on(t.postId, t.accountId), index('publish_targets_status_idx').on(t.status)],
);

// ---------------------------------------------------------------------------------------------
// Business tools (Stage C)
// ---------------------------------------------------------------------------------------------

export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: text('id').primaryKey(),
    /** One row per provider; same list as CONNECTION_PROVIDERS in @studio/core (text enum, no CHECK constraint). */
    provider: text('provider', {
      enum: ['square', 'resend', 'google_business_profile', 'google_search_console', 'website', 'meta', 'zernio', 'postmark', 'google_places'],
    }).notNull(),
    /** Same list as CONNECTION_STATUSES in @studio/core. `disconnected` keeps the row (and its history) without a credential. */
    status: text('status', { enum: ['not_configured', 'connected', 'needs_reauth', 'error', 'disconnected'] }).notNull().default('not_configured'),
    externalAccountId: text('external_account_id'),
    displayName: text('display_name').notNull().default(''),
    accessTokenEncrypted: text('access_token_encrypted'),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Capabilities verified against the live account by read-only checks (e.g. bookings write allowed), plus
     * verification markers written only by explicit owner actions.
     */
    capabilities: jsonb('capabilities').$type<Record<string, boolean | string | number | null>>().notNull().default({}),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [uniqueIndex('integration_connections_provider_idx').on(t.provider)],
);

export const customers = pgTable(
  'customers',
  {
    id: text('id').primaryKey(),
    squareCustomerId: text('square_customer_id'),
    givenName: text('given_name').notNull().default(''),
    familyName: text('family_name').notNull().default(''),
    email: text('email'),
    phone: text('phone'),
    /** Marketing consent (Spam Act 2003): null = unknown, true/false = recorded. */
    marketingConsent: boolean('marketing_consent'),
    marketingConsentSource: text('marketing_consent_source').notNull().default(''),
    marketingConsentAt: timestamp('marketing_consent_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    reviewRequestsOptOut: boolean('review_requests_opt_out').notNull().default(false),
    /**
     * Square's read-only `preferences.email_unsubscribed`, filled by the Square sync (null = not known). The email
     * module treats `true` as a block on marketing email and records its own consent-ledger event.
     */
    squareEmailUnsubscribed: boolean('square_email_unsubscribed'),
    notes: text('notes').notNull().default(''),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('customers_square_idx').on(t.squareCustomerId), index('customers_email_idx').on(sql`lower(${t.email})`)],
);

export const bookings = pgTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    squareBookingId: text('square_booking_id').notNull(),
    squareVersion: integer('square_version').notNull().default(0),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    locationId: text('location_id').notNull().default(''),
    teamMemberId: text('team_member_id'),
    serviceName: text('service_name').notNull().default(''),
    serviceVariationId: text('service_variation_id'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(0),
    status: text('status').notNull(),
    /** How completion was established: payment, explicit owner flag or none. */
    completionSource: text('completion_source', { enum: ['none', 'payment', 'owner_marked', 'square_status'] }).notNull().default('none'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex('bookings_square_idx').on(t.squareBookingId), index('bookings_start_idx').on(t.startAt), index('bookings_customer_idx').on(t.customerId)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('webhook_events_provider_ext_idx').on(t.provider, t.externalEventId)],
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    purpose: text('purpose', { enum: ['follow_up', 'review_request', 'campaign', 'rebooking', 'custom'] }).notNull(),
    subject: text('subject').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    /** Commercial (marketing) messages require consent and an unsubscribe link under the Spam Act. */
    isCommercial: boolean('is_commercial').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
);

export const emailMessages = pgTable(
  'email_messages',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').references(() => emailTemplates.id, { onDelete: 'set null' }),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    bookingId: text('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    bodyText: text('body_text').notNull(),
    purpose: text('purpose').notNull(),
    /** Prevents duplicate sends for the same trigger (e.g. follow_up:bookingId). */
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status', { enum: ['draft', 'approved', 'queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed'] })
      .notNull()
      .default('draft'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('email_messages_dedupe_idx').on(t.dedupeKey), index('email_messages_status_idx').on(t.status, t.scheduledFor)],
);

export const reviewRequests = pgTable(
  'review_requests',
  {
    id: text('id').primaryKey(),
    bookingId: text('booking_id').references(() => bookings.id, { onDelete: 'set null' }),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    channel: text('channel', { enum: ['email', 'sms', 'manual_link'] }).notNull(),
    emailMessageId: text('email_message_id').references(() => emailMessages.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['pending_approval', 'scheduled', 'sent', 'skipped', 'failed', 'cancelled'] }).notNull(),
    skipReason: text('skip_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('review_requests_booking_idx').on(t.bookingId), index('review_requests_status_idx').on(t.status)],
);

/** Reviews are only stored when an authorised integration provides them; never typed in by hand. */
export const reviews = pgTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    externalReviewId: text('external_review_id').notNull(),
    rating: integer('rating'),
    reviewerName: text('reviewer_name').notNull().default(''),
    comment: text('comment').notNull().default(''),
    reviewCreatedAt: timestamp('review_created_at', { withTimezone: true }),
    replyText: text('reply_text'),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reviews_provider_ext_idx').on(t.provider, t.externalReviewId)],
);

export const websiteAudits = pgTable(
  'website_audits',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    status: text('status', { enum: ['queued', 'running', 'complete', 'failed'] }).notNull().default('queued'),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    ...timestamps,
  },
  (t) => [index('website_audits_created_idx').on(t.createdAt)],
);

export const websiteEdits = pgTable(
  'website_edits',
  {
    id: text('id').primaryKey(),
    auditId: text('audit_id').references(() => websiteAudits.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    rationale: text('rationale').notNull().default(''),
    pageUrl: text('page_url').notNull().default(''),
    proposedChange: jsonb('proposed_change').$type<Record<string, unknown>>().notNull(),
    status: text('status', { enum: ['proposed', 'approved', 'applied', 'rejected'] }).notNull().default('proposed'),
    appliedVia: text('applied_via'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    ...timestamps,
  },
);

// ---------------------------------------------------------------------------------------------
// Relations (for the relational query API)
// ---------------------------------------------------------------------------------------------

export const projectsRelations = relations(projects, ({ many, one }) => ({
  owner: one(users, { fields: [projects.ownerId], references: [users.id] }),
  assets: many(mediaAssets),
  generations: many(generations),
  edits: many(edits),
}));

export const mediaAssetsRelations = relations(mediaAssets, ({ one }) => ({
  project: one(projects, { fields: [mediaAssets.projectId], references: [projects.id] }),
}));

export const generationsRelations = relations(generations, ({ one, many }) => ({
  project: one(projects, { fields: [generations.projectId], references: [projects.id] }),
  edits: many(edits),
}));

export const editsRelations = relations(edits, ({ one, many }) => ({
  project: one(projects, { fields: [edits.projectId], references: [projects.id] }),
  generation: one(generations, { fields: [edits.generationId], references: [generations.id] }),
  versions: many(editVersions),
}));

export const editVersionsRelations = relations(editVersions, ({ one }) => ({
  edit: one(edits, { fields: [editVersions.editId], references: [edits.id] }),
}));

export const publishPostsRelations = relations(publishPosts, ({ many }) => ({
  targets: many(publishTargets),
}));

export const publishTargetsRelations = relations(publishTargets, ({ one }) => ({
  post: one(publishPosts, { fields: [publishTargets.postId], references: [publishPosts.id] }),
  account: one(socialAccounts, { fields: [publishTargets.accountId], references: [socialAccounts.id] }),
}));

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type MediaAsset = typeof mediaAssets.$inferSelect;
export type MusicTrack = typeof musicTracks.$inferSelect;
export type Generation = typeof generations.$inferSelect;
export type Edit = typeof edits.$inferSelect;
export type EditVersion = typeof editVersions.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type UploadSession = typeof uploadSessions.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
