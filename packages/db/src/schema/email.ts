import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamps } from './common.js';
// Circular import is safe: the references are only resolved lazily inside the callbacks below.
import { customers, emailMessages, emailTemplates, reviewRequests, users, webhookEvents } from '../schema.js';

/**
 * Tables of the email and review requests module (WP7, email design §5.2). `../schema.ts` re-exports this file, so
 * the app, the worker and drizzle-kit all see the tables. The changes to `email_templates`, `email_messages` and
 * `review_requests` live in their blocks in `../schema.ts`.
 */

/** Campaign audience filter: clients with email permission, optionally only those who visited recently. */
export interface CampaignAudience {
  lastVisitWithinDays: 90 | 180 | 365 | null;
}

/** An occasional campaign to clients who agreed to marketing email (design §4.4). Always needs the owner's approval. */
export const emailCampaigns = pgTable(
  'email_campaigns',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    templateId: text('template_id').references(() => emailTemplates.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    audience: jsonb('audience').$type<CampaignAudience>().notNull().default({ lastVisitWithinDays: null }),
    /** sha256 of the sorted recipient ids and the content, from the preview the owner approved. */
    audienceHash: text('audience_hash'),
    recipientCount: integer('recipient_count').notNull().default(0),
    status: text('status', { enum: ['draft', 'approved', 'sending', 'paused', 'sent', 'cancelled'] }).notNull().default('draft'),
    pausedReason: text('paused_reason').notNull().default(''),
    sentCount: integer('sent_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    bounceCount: integer('bounce_count').notNull().default(0),
    complaintCount: integer('complaint_count').notNull().default(0),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('email_campaigns_created_idx').on(t.createdAt)],
);

/** Evidence kept with a consent event (never an IP address). */
export interface ConsentEvidence {
  userAgent?: string;
  emailMessageId?: string;
  webhookEventId?: string;
  note?: string;
}

/**
 * The append-only consent ledger (memo §8): every grant and withdrawal with the exact wording shown, the method and
 * the evidence. Consent is per address (`email_lower`). No route updates or deletes rows; kept at least 24 months and
 * not removed when a client is deleted.
 */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    emailLower: text('email_lower').notNull(),
    kind: text('kind', { enum: ['granted', 'withdrawn'] }).notNull(),
    /** `express` for grants; '' for withdrawals. */
    basis: text('basis').notNull().default(''),
    scope: text('scope').notNull().default('marketing'),
    method: text('method').notNull(),
    /** The exact wording shown (grants), with the business name filled in. */
    wording: text('wording').notNull().default(''),
    wordingHash: text('wording_hash').notNull().default(''),
    evidence: jsonb('evidence').$type<ConsentEvidence>().notNull().default({}),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consent_events_email_idx').on(t.emailLower, t.occurredAt), index('consent_events_customer_idx').on(t.customerId, t.occurredAt)],
);

/**
 * The app's global suppression list (Postmark's lists are per stream). Hard bounces and spam complaints block
 * everything (`all`); unsubscribes block marketing only. Never deleted; lifting sets `lifted_at`.
 */
export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    id: text('id').primaryKey(),
    emailLower: text('email_lower').notNull(),
    scope: text('scope', { enum: ['all', 'marketing'] }).notNull(),
    reason: text('reason', { enum: ['hard_bounce', 'spam_complaint', 'unsubscribe', 'provider_inactive', 'manual_block'] }).notNull(),
    source: text('source', { enum: ['postmark_webhook', 'unsubscribe_page', 'one_click', 'owner', 'send_error', 'square_preference'] }).notNull(),
    stream: text('stream'),
    emailMessageId: text('email_message_id').references(() => emailMessages.id, { onDelete: 'set null' }),
    webhookEventId: text('webhook_event_id').references(() => webhookEvents.id, { onDelete: 'set null' }),
    pushedToProviderAt: timestamp('pushed_to_provider_at', { withTimezone: true }),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedBy: text('lifted_by').references(() => users.id, { onDelete: 'set null' }),
    liftNote: text('lift_note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('email_suppressions_active_idx').on(t.emailLower, t.scope, t.reason).where(sql`${t.liftedAt} IS NULL`),
    index('email_suppressions_email_idx').on(t.emailLower),
  ],
);

/**
 * Earlier personal link tokens of a message that was claimed more than once ("Send again" after the owner checked an
 * unknown outcome). The current token hashes stay on `email_messages.unsubscribe_token_hash` and
 * `review_requests.click_token_hash`; a re-claim moves the previous hash here first, so a copy of the email that did
 * reach the client keeps a working `/u/{token}` and `/r/{token}` link. Only SHA-256 hashes are stored.
 */
export const emailLinkTokens = pgTable(
  'email_link_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind', { enum: ['unsubscribe', 'review_click'] }).notNull(),
    emailMessageId: text('email_message_id')
      .notNull()
      .references(() => emailMessages.id, { onDelete: 'cascade' }),
    /** The review request a `review_click` token counts opens for. */
    reviewRequestId: text('review_request_id').references(() => reviewRequests.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('email_link_tokens_message_idx').on(t.emailMessageId)],
);

export type EmailCampaignRow = typeof emailCampaigns.$inferSelect;
export type ConsentEventRow = typeof consentEvents.$inferSelect;
export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;

