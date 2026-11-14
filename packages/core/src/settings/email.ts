import { z } from 'zod';
import type { SettingsSectionMap } from './types.js';

const TimeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** One automation (follow-up email or review requests): off by default, approve-each by default (design §4.3). */
export const AutomationSchema = z.object({
  enabled: z.boolean().default(false),
  /** When the switch was last turned on; only appointments completed after this count. */
  enabledAt: z.string().datetime().nullable().default(null),
  mode: z.enum(['approve_each', 'send_automatically']).default('approve_each'),
  templateId: z.string().nullable().default(null),
  delayHours: z.number().int().min(1).max(72).default(3),
  dailyCap: z.number().int().min(1).max(100).default(10),
});
export type AutomationSettings = z.infer<typeof AutomationSchema>;

/** The consent wording shown to clients; `{business_name}` is filled in and the filled-in text is what the ledger keeps. */
export const DEFAULT_CONSENT_WORDING =
  "Yes, I'd like emails from {business_name} with news, offers and the occasional request for feedback. " +
  'I can unsubscribe at any time. Emails are sent through our email provider, Postmark, in the United States.';

/** Email settings (Emails page; owner only). */
export const EmailSettingsSchema = z.object({
  /** Shown as the sender's name; '' → the business name. */
  senderName: z.string().max(80).default(''),
  /** Reply-To address; '' → Settings → Business email. */
  replyTo: z.string().max(120).default(''),
  consentWording: z.string().min(20).max(600).default(DEFAULT_CONSENT_WORDING),
  /** The memo's conservative "inferred" rule (2 completed visits in 12 months). Off by default. */
  allowInferredConsent: z.boolean().default(false),
  sendWindow: z.object({ start: TimeOfDay.default('09:00'), end: TimeOfDay.default('19:00') }).default({ start: '09:00', end: '19:00' }),
  /** Most commercial emails (review requests and campaigns) sent per Melbourne day. */
  dailyCommercialCap: z.number().int().min(1).max(500).default(50),
  /** What Square already sends for the owner (ticked by the owner; null = not answered). */
  squareSends: z
    .object({ confirmations: z.boolean().nullable().default(null), reminders: z.boolean().nullable().default(null), feedbackOrReviews: z.boolean().nullable().default(null) })
    .default({ confirmations: null, reminders: null, feedbackOrReviews: null }),
  /** The owner ticked "I added the webhook" (used only when Postmark's webhook list cannot be read with the server token). */
  webhooksAttested: z.boolean().default(false),
  followUp: AutomationSchema.default(AutomationSchema.parse({})),
});
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;

/** Review request settings (Reviews page; owner only). */
export const ReviewSettingsSchema = z.object({
  automation: AutomationSchema.default(AutomationSchema.parse({})),
  /** Same rule for everyone: at most one request per client in this many days. */
  minDaysBetweenRequests: z.number().int().min(30).max(730).default(365),
  /** Automation only: completions older than this are never asked (no back-catalogue blast). */
  maxAgeDays: z.number().int().min(1).max(14).default(7),
});
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

/** New top-level settings sections of the email and review requests module (each with a full default). */
export const EMAIL_SETTINGS_SECTIONS = {
  email: EmailSettingsSchema.default(EmailSettingsSchema.parse({})),
  reviews: ReviewSettingsSchema.default(ReviewSettingsSchema.parse({})),
} as const satisfies SettingsSectionMap;
