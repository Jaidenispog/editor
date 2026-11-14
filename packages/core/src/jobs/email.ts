import { z } from 'zod';
import type { JobPayloadSchemaMap } from './types.js';

/** Job type names of the email and review requests module (WP7). Payloads hold ids only, never addresses or tokens. */
export const EMAIL_JOB_TYPES = {
  /** Sends one approved email through the provider (state machine with duplicate protection, design §6.2). */
  EMAIL_SEND: 'email.send',
  /** Every minute: hands due approved emails to `email.send`. Never calls the provider itself. */
  EMAIL_DISPATCH: 'email.dispatch',
  /** Every 10 minutes: creates follow-ups and review requests for genuinely completed appointments, and cancels stale ones. */
  EMAIL_AUTOMATION_SWEEP: 'email.automation.sweep',
  /** Turns an approved campaign into one message per recipient, spread by the daily limit. */
  EMAIL_CAMPAIGN_EXPAND: 'email.campaign.expand',
  /** Read-only provider check (server, streams, webhooks, DNS hints). Never sends. */
  EMAIL_PROVIDER_CHECK: 'email.provider.check',
  /** Adds a suppressed address to Postmark's suppression list (only ever restricts sending). */
  EMAIL_SUPPRESSION_PUSH: 'email.suppression.push',
  /** Google rating and review count from Places API (New); read-only, at most daily plus owner refreshes. */
  REVIEWS_PLACES_SYNC: 'reviews.places.sync',
} as const;

export const EmailSendPayloadSchema = z.object({ emailMessageId: z.string().min(1) });
export const EmailDispatchPayloadSchema = z.object({});
export const EmailSweepPayloadSchema = z.object({});
export const EmailCampaignExpandPayloadSchema = z.object({ campaignId: z.string().min(1) });
export const EmailProviderCheckPayloadSchema = z.object({ reason: z.enum(['manual', 'daily', 'startup']) });
export const EmailSuppressionPushPayloadSchema = z.object({ suppressionId: z.string().min(1) });
export const ReviewsPlacesSyncPayloadSchema = z.object({ reason: z.enum(['connect', 'daily', 'manual']) });

/** Payload schemas of the email and review requests module's job types, keyed by job type. */
export const EMAIL_JOB_PAYLOAD_SCHEMAS = {
  [EMAIL_JOB_TYPES.EMAIL_SEND]: EmailSendPayloadSchema,
  [EMAIL_JOB_TYPES.EMAIL_DISPATCH]: EmailDispatchPayloadSchema,
  [EMAIL_JOB_TYPES.EMAIL_AUTOMATION_SWEEP]: EmailSweepPayloadSchema,
  [EMAIL_JOB_TYPES.EMAIL_CAMPAIGN_EXPAND]: EmailCampaignExpandPayloadSchema,
  [EMAIL_JOB_TYPES.EMAIL_PROVIDER_CHECK]: EmailProviderCheckPayloadSchema,
  [EMAIL_JOB_TYPES.EMAIL_SUPPRESSION_PUSH]: EmailSuppressionPushPayloadSchema,
  [EMAIL_JOB_TYPES.REVIEWS_PLACES_SYNC]: ReviewsPlacesSyncPayloadSchema,
} as const satisfies JobPayloadSchemaMap;
