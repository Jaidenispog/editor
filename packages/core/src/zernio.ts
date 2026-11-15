import { z } from 'zod';

/**
 * Contracts of the optional TikTok route through Zernio (docs/design/publishing.md §7.2, facts quoted in
 * docs/research/zernio-api.md). Pure and browser-safe: the request bodies the app sends, the owner's consent and the
 * TikTok interaction choices bound by approval, the poll schedule and the limits. The worker's adapter builds every
 * Zernio request from these schemas, and the tests' fake asserts them, so no unknown field is ever sent (Zernio drops
 * unknown body fields silently, zernio-api §2).
 */

/** Zernio's production API root (zernio-api §1: the OpenAPI server; every path starts with `/v1`). */
export const ZERNIO_DEFAULT_BASE_URL = 'https://zernio.com/api';

/** Business-lane TikTok accounts: 15 videos per account per rolling 24 hours; posts over it are held, not failed (zernio-api §7). */
export const ZERNIO_DAILY_VIDEO_CAP = 15;

/** Uploads expire after 7 days (zernio-api §5); an upload older than this is made again before a create. */
export const ZERNIO_UPLOAD_REUSE_MAX_SEC = 6 * 86_400;

/** TikTok can hold a post at `publishing` for up to 48 hours (zernio-api §9), so polling runs to 50 hours. */
export const ZERNIO_POLL_WINDOW_SEC = 50 * 3600;

/**
 * Between 6 h and 50 h the post is read hourly (design §7.2.4 step 6). The dispatcher's stall safety net leaves a
 * Zernio target with a post id alone while its next read is queued, so the interval does not need to stay under it.
 */
export const ZERNIO_LONG_POLL_INTERVAL_SEC = 60 * 60;

/** The only privacy level a Business-lane video direct post may use (zernio-api §4, §6). */
export const ZERNIO_PUBLIC_PRIVACY = 'PUBLIC_TO_EVERYONE';

/** An API key as pasted by the owner: 10–200 characters (a full key is 67, zernio-api §1). The prefix is never checked. */
export const ZernioConnectSchema = z.object({ apiKey: z.string().trim().min(10, 'Paste the whole Zernio API key.').max(200, 'That is longer than a Zernio API key.') }).strict();

/** The TikTok account the owner picks from the candidates Zernio listed. */
export const ZernioAccountChoiceSchema = z.object({ zernioAccountId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Choose one of the listed TikTok accounts.') }).strict();

/** The owner's Comments / Duets / Stitches choices (TikTok requires them and forbids defaults, zernio-api §6). */
export const TiktokInteractionsSchema = z.object({ allowComment: z.boolean(), allowDuet: z.boolean(), allowStitch: z.boolean() }).strict();
export type TiktokInteractions = z.infer<typeof TiktokInteractionsSchema>;

/** One interaction descriptor from creator info, as stored by the read-only check (`enabled` false = turned off in TikTok). */
export interface TiktokInteractionSeed {
  enabled: boolean;
  default: boolean;
}

/** Creator-info seeds for the review card's three switches. */
export interface TiktokInteractionSeeds {
  allowComment: TiktokInteractionSeed;
  allowDuet: TiktokInteractionSeed;
  allowStitch: TiktokInteractionSeed;
}

const INTERACTION_KEYS = ['allowComment', 'allowDuet', 'allowStitch'] as const;

/**
 * The interaction seeds stored in a social account's capabilities (`allowCommentEnabled`, `allowCommentDefault`, …),
 * or null when the read-only check has not read creator info yet.
 */
export function interactionSeedsFrom(capabilities: Record<string, unknown>): TiktokInteractionSeeds | null {
  const out: Partial<TiktokInteractionSeeds> = {};
  for (const k of INTERACTION_KEYS) {
    const enabled = capabilities[`${k}Enabled`];
    if (typeof enabled !== 'boolean') return null;
    out[k] = { enabled, default: enabled && capabilities[`${k}Default`] === true };
  }
  return out as TiktokInteractionSeeds;
}

/** Which of the owner's choices TikTok has turned off (a switch the owner turned on that creator info reports disabled). */
export function disabledInteractionChoices(choice: TiktokInteractions, seeds: TiktokInteractionSeeds | null): Array<keyof TiktokInteractions> {
  if (!seeds) return [];
  return INTERACTION_KEYS.filter((k) => choice[k] && !seeds[k].enabled);
}

/** Plain names of the three switches. */
export const TIKTOK_INTERACTION_LABELS: Record<keyof TiktokInteractions, string> = { allowComment: 'Comments', allowDuet: 'Duets', allowStitch: 'Stitches' };

/**
 * What the owner saw and approved for one Zernio destination (plan §10.3: approval binds the exact change and
 * destination). Stored with the consent on the target; the worker compares it with the target as it is just before
 * the non-repeatable create and refuses on any difference.
 */
export const ZernioBindingSchema = z
  .object({
    caption: z.string(),
    coverTimeSec: z.number().nullable(),
    variant: z.enum(['standard', 'no_music']),
    delivery: z.enum(['publish', 'draft']),
    accountRowId: z.string(),
    handle: z.string(),
    interactions: TiktokInteractionsSchema,
  })
  .strict();
export type ZernioBinding = z.infer<typeof ZernioBindingSchema>;

/** The consent stored on a Zernio target at approval (`provider_state.consent`). */
export const ZernioConsentSchema = z.object({
  tiktokPublic: z.literal(true),
  at: z.string(),
  userId: z.string(),
  binding: ZernioBindingSchema,
});
export type ZernioConsent = z.infer<typeof ZernioConsentSchema>;

/** True when the target as it is now is exactly what the owner approved. */
export function zernioBindingMatches(approved: ZernioBinding, now: ZernioBinding): boolean {
  return (
    approved.caption === now.caption &&
    (approved.coverTimeSec ?? null) === (now.coverTimeSec ?? null) &&
    approved.variant === now.variant &&
    approved.delivery === now.delivery &&
    approved.accountRowId === now.accountRowId &&
    approved.handle.toLowerCase() === now.handle.toLowerCase() &&
    INTERACTION_KEYS.every((k) => approved.interactions[k] === now.interactions[k])
  );
}

/** `POST /v1/media/presign` body (zernio-api §5). */
export const ZernioPresignBodySchema = z
  .object({
    filename: z.string().min(1).max(200),
    contentType: z.literal('video/mp4'),
    size: z.number().int().positive(),
  })
  .strict();
export type ZernioPresignBody = z.infer<typeof ZernioPresignBodySchema>;

/**
 * `tiktokSettings` of a TikTok post (zernio-api §6, fields page, snake_case names). `draft: true` sends the video to
 * the creator's TikTok inbox (zernio-api §8). Never `isDraft`, `publish_type`, `video_made_with_ai` or
 * `commercialContentType` (design §7.2.3, open question 5).
 */
export const ZernioTiktokSettingsSchema = z
  .object({
    privacy_level: z.literal(ZERNIO_PUBLIC_PRIVACY),
    allow_comment: z.boolean(),
    allow_duet: z.boolean(),
    allow_stitch: z.boolean(),
    content_preview_confirmed: z.literal(true),
    express_consent_given: z.literal(true),
    video_cover_timestamp_ms: z.number().int().min(0),
    draft: z.literal(true).optional(),
  })
  .strict();

/** `POST /v1/posts` body for one TikTok video (design §7.2.4 step 5b). Strict: nothing else is ever sent. */
export const ZernioCreatePostBodySchema = z
  .object({
    content: z.string().max(10_000),
    mediaItems: z.array(z.object({ type: z.literal('video'), url: z.string().url() }).strict()).length(1),
    platforms: z.array(z.object({ platform: z.literal('tiktok'), accountId: z.string().min(1) }).strict()).length(1),
    tiktokSettings: ZernioTiktokSettingsSchema,
    publishNow: z.literal(true),
    metadata: z.object({ studioTargetId: z.string().min(1) }).strict(),
  })
  .strict();
export type ZernioCreatePostBody = z.infer<typeof ZernioCreatePostBodySchema>;

/** Builds the create body from the target's facts (validated, so a wrong field fails here, before any call). */
export function buildZernioCreateBody(input: {
  targetId: string;
  caption: string;
  mediaUrl: string;
  zernioAccountId: string;
  interactions: TiktokInteractions;
  coverTimeSec: number | null;
  delivery: 'publish' | 'draft';
}): ZernioCreatePostBody {
  return ZernioCreatePostBodySchema.parse({
    content: input.caption,
    mediaItems: [{ type: 'video', url: input.mediaUrl }],
    platforms: [{ platform: 'tiktok', accountId: input.zernioAccountId }],
    tiktokSettings: {
      privacy_level: ZERNIO_PUBLIC_PRIVACY,
      allow_comment: input.interactions.allowComment,
      allow_duet: input.interactions.allowDuet,
      allow_stitch: input.interactions.allowStitch,
      content_preview_confirmed: true,
      express_consent_given: true,
      video_cover_timestamp_ms: Math.max(0, Math.round((input.coverTimeSec ?? 0) * 1000)),
      ...(input.delivery === 'draft' ? { draft: true } : {}),
    },
    publishNow: true,
    metadata: { studioTargetId: input.targetId },
  });
}

/** Seconds after the create at which the post is read: 1, 2, 5 and 10 minutes, then every 15 minutes to 6 hours. */
const EARLY_POLL_OFFSETS_SEC = [60, 120, 300, 600];

/**
 * Seconds until the next read of a Zernio post, given the seconds since it was submitted: at 1, 2, 5 and 10 minutes,
 * then every 15 minutes up to 6 hours, then hourly ({@link ZERNIO_LONG_POLL_INTERVAL_SEC}). The last read is always at
 * the end of the 50-hour window itself, whatever the grid. Null once the window is over: the caller then moves a
 * target that is still waiting to `check_before_retry`.
 */
export function zernioPollDelaySeconds(elapsedSec: number): number | null {
  const e = Math.max(0, elapsedSec);
  if (e + 5 >= ZERNIO_POLL_WINDOW_SEC) return null;
  for (const o of EARLY_POLL_OFFSETS_SEC) if (o > e + 5) return o - e;
  let next: number;
  if (e + 5 < 6 * 3600) next = 600 + Math.ceil((e + 5 - 600) / 900) * 900;
  else next = 6 * 3600 + Math.ceil((e + 5 - 6 * 3600) / ZERNIO_LONG_POLL_INTERVAL_SEC) * ZERNIO_LONG_POLL_INTERVAL_SEC;
  return Math.max(30, Math.round(Math.min(next, ZERNIO_POLL_WINDOW_SEC) - e));
}

/**
 * After an unclear create (time-out, 5xx, 429, `idempotency_conflict`) the post is looked up by its metadata at 1, 2,
 * 5 and 10 minutes (design §7.2.4 step 5d). Returns the delay before lookup number `attempt` (0-based), or null when
 * the lookups are used up (the owner checks TikTok, `check_before_retry`).
 */
export function zernioLookupDelaySeconds(attempt: number, minWaitSec = 0): number | null {
  const gaps = [60, 60, 180, 300];
  const g = gaps[attempt];
  return g === undefined ? null : Math.max(g, minWaitSec);
}

/** A webhook delivery reduced to what the worker needs (plan §10.3: store an envelope, never the provider's copy). */
export interface ZernioWebhookEnvelope {
  id: string | null;
  event: string;
  postId: string | null;
  studioTargetId: string | null;
  platform: string | null;
  accountId: string | null;
}

/** Webhook events the app listens to (zernio-api §11). */
export const ZERNIO_WEBHOOK_EVENTS = ['post.platform.published', 'post.platform.failed', 'post.published', 'post.partial', 'post.failed', 'post.tiktok.url_resolved', 'account.disconnected'] as const;

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

/** Picks the envelope fields from a parsed webhook body (anything else in it is dropped). */
export function zernioWebhookEnvelope(body: unknown): ZernioWebhookEnvelope {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const post = (b['post'] && typeof b['post'] === 'object' ? b['post'] : {}) as Record<string, unknown>;
  const metadata = (post['metadata'] && typeof post['metadata'] === 'object' ? post['metadata'] : {}) as Record<string, unknown>;
  const platform = (b['platform'] && typeof b['platform'] === 'object' ? b['platform'] : {}) as Record<string, unknown>;
  const account = (b['account'] && typeof b['account'] === 'object' ? b['account'] : {}) as Record<string, unknown>;
  return {
    id: str(b['id']),
    event: str(b['event'], 80) ?? 'unknown',
    postId: str(post['id']),
    studioTargetId: str(metadata['studioTargetId'], 64),
    platform: str(platform['name'], 40),
    accountId: str(account['accountId']) ?? str(platform['accountId']),
  };
}
