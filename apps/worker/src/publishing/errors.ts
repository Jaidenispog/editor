import { GraphApiError } from '../lib/meta/graph.js';
import { HttpTimeoutError } from '../lib/http.js';

/**
 * What to do with a failed Graph call:
 * - `transient`: rethrow so pg-boss retries with backoff (rate limits, 5xx, network, time-outs).
 * - `reauth`: the token is invalid or expired; the account needs reconnecting.
 * - `quota`: the publishing quota is used up; back to queued and try again in an hour.
 * - `not_ready`: the media is still processing; keep polling.
 * - `permission`: a permission is missing; the connection shows an error and the target fails (not retryable).
 * - `discovery`: the object is not shared with the app (100/33); the connection shows the discovery hint.
 * - `permanent`: the platform refused the post; the target fails and is not retried.
 */
export type GraphErrorKind = 'transient' | 'reauth' | 'quota' | 'not_ready' | 'permission' | 'discovery' | 'permanent';

/** A mapped error: its kind, a plain message for the owner, and whether Retry makes sense later. */
export interface MappedGraphError {
  kind: GraphErrorKind;
  message: string;
  retryable: boolean;
}

/** Shown when Meta did not share the Instagram account with the app (memo §4: community report). */
export const DISCOVERY_HINT =
  "Meta didn't share the Instagram account with this app. In Business Settings, assign the Instagram account to the system user, or add business_management to the configuration.";

/**
 * Maps a Graph error (memo §4: the meanings come from third-party tables only, so Meta's own message is always kept
 * next to the plain summary). Unknown 4xx answers are permanent; anything else unknown is transient.
 */
export function mapGraphError(err: unknown): MappedGraphError {
  if (err instanceof HttpTimeoutError) return { kind: 'transient', message: 'Instagram did not answer in time.', retryable: true };
  if (!(err instanceof GraphApiError)) return { kind: 'transient', message: 'Instagram could not be reached.', retryable: true };
  const meta = err.userMessage ? `${err.message} (${err.userMessage})` : err.message;
  const with_ = (summary: string) => `${summary} Instagram said: ${meta}`;
  const { code, subcode, httpStatus } = err;
  if (code === 190) return { kind: 'reauth', message: with_('Instagram needs reconnecting: the access token is no longer valid.'), retryable: false };
  if (subcode === 2207042) return { kind: 'quota', message: with_("Instagram's daily posting limit is reached."), retryable: true };
  if (code === 9007 || subcode === 2207027) return { kind: 'not_ready', message: 'Instagram is still processing the video.', retryable: true };
  if (subcode === 2207026) return { kind: 'permanent', message: with_("Instagram couldn't use this video file."), retryable: false };
  if (subcode === 2207050) return { kind: 'permanent', message: with_('Instagram has restricted this account.'), retryable: false };
  if (subcode === 2207051) return { kind: 'permanent', message: with_('Instagram blocked this post as possible spam. Try posting it yourself later.'), retryable: false };
  if (subcode === 2207003) return { kind: 'transient', message: with_('Instagram timed out fetching the video.'), retryable: true };
  if (code === 100 && subcode === 33) return { kind: 'discovery', message: DISCOVERY_HINT, retryable: false };
  if (code === 4 || code === 17 || code === 32 || code === 613) return { kind: 'transient', message: with_('Instagram is limiting requests for a moment.'), retryable: true };
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return { kind: 'permission', message: with_('A permission is missing from the Meta configuration (instagram_basic and instagram_content_publish are needed).'), retryable: false };
  }
  if (httpStatus >= 500 || httpStatus === 429) return { kind: 'transient', message: with_('Instagram had a temporary problem.'), retryable: true };
  if (httpStatus >= 400) return { kind: 'permanent', message: with_('Instagram refused this request.'), retryable: false };
  return { kind: 'transient', message: with_('Instagram gave an unexpected answer.'), retryable: true };
}

// ---------------------------------------------------------------------------------------------
// Zernio (TikTok provider, design §7.2.4 "Error mapping"; facts in docs/research/zernio-api.md §2)
// ---------------------------------------------------------------------------------------------

/**
 * An error answer from the Zernio API. Zernio's envelope is flat (`{ error, type, code, param, details }`); `type`
 * and `code` are stable, `error` is free text that is only ever shown to the owner, never branched on.
 */
export class ZernioApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly type: string | null,
    readonly code: string | null,
    message: string,
    readonly details: Record<string, unknown>,
    /** Seconds from `Retry-After` (429 and `idempotency_conflict`), when sent. */
    readonly retryAfterSec: number | null,
    /** `required_group` of a 403 `insufficient_permissions` (the key lacks a resource group). */
    readonly requiredGroup: string | null,
  ) {
    super(message);
    this.name = 'ZernioApiError';
  }
}

/**
 * What to do with a failed Zernio call (branching on HTTP status, `type` and `code` only):
 * - `transient`: retry later (5xx, 503, network, time-out, before anything was sent).
 * - `unknown`: only after a create: the post may exist; never create again, look it up by its metadata (step 5d).
 * - `reauth_key`: 401, Zernio refused the key; the connection needs a new key.
 * - `reauth_account`: the TikTok account must be reconnected in Zernio or chosen again.
 * - `key_scope`: 403 `insufficient_permissions`, the key lacks a resource group (a key problem, not a reconnect).
 * - `account_blocked`: 403 `ACCOUNT_NOT_ENABLED_FOR_POSTING` / `PROFILE_OVER_LIMIT`.
 * - `billing`: any 402 (the code strings differ between Zernio's pages, so only the status counts).
 * - `duplicate`: 409 with `details.existingPostId` (the same content already went to the account in 24 h).
 * - `conflict`: any other 409 (`ads_connection_required` among them): failed, the owner may retry, the account is checked.
 * - `rate_limited`: 429 before submitting (wait `Retry-After`; an account cooldown also answers 429).
 * - `not_found`: 404 (an account or post Zernio no longer has).
 * - `refused`: 400 or any other 4xx: failed, not retried automatically; an expired upload is one of these.
 */
export type ZernioErrorKind =
  | 'transient'
  | 'unknown'
  | 'reauth_key'
  | 'reauth_account'
  | 'key_scope'
  | 'account_blocked'
  | 'billing'
  | 'duplicate'
  | 'conflict'
  | 'rate_limited'
  | 'not_found'
  | 'refused';

/** A mapped Zernio error with a plain message for the owner. */
export interface MappedZernioError {
  kind: ZernioErrorKind;
  message: string;
  /** Whether the owner's Retry button makes sense for the target afterwards. */
  retryable: boolean;
}

/** Shown when the TikTok account needs reconnecting inside Zernio. */
export const ZERNIO_RECONNECT_MESSAGE = 'Reconnect TikTok in Zernio and approve every permission.';
/** Shown when the stored account id is no longer listed (Zernio may give an account a new id when it is reconnected). */
export const ZERNIO_CHOOSE_AGAIN_MESSAGE =
  'Choose your TikTok account again in Settings → Integrations: Zernio no longer lists the one you chose (this can happen after reconnecting TikTok in Zernio).';
/** Shown when Zernio refused the key. */
export const ZERNIO_KEY_REFUSED_MESSAGE = "Zernio didn't accept this key. Paste a new Zernio API key in Settings → Integrations.";

/**
 * Maps a failed Zernio call. `afterCreate` is true for the create call once `submitted_at` is set: then every
 * outcome that does not prove nothing was created (time-out, network error, 5xx, 429, `idempotency_conflict`) is
 * `unknown`, never `transient`.
 */
export function mapZernioError(err: unknown, options: { afterCreate?: boolean } = {}): MappedZernioError {
  const unclear = (message: string): MappedZernioError => (options.afterCreate ? { kind: 'unknown', message, retryable: false } : { kind: 'transient', message, retryable: true });
  if (err instanceof HttpTimeoutError) return unclear('Zernio did not answer in time.');
  if (!(err instanceof ZernioApiError)) return unclear('Zernio could not be reached.');
  const said = err.message ? ` Zernio said: ${err.message.slice(0, 300)}` : '';
  const { httpStatus: status, code } = err;
  if (status === 401) return { kind: 'reauth_key', message: ZERNIO_KEY_REFUSED_MESSAGE, retryable: false };
  if (status === 402) return { kind: 'billing', message: 'Zernio refused for a billing reason. Check your Zernio billing page, then try again.', retryable: true };
  if (status === 403) {
    if (code === 'insufficient_permissions') {
      return { kind: 'key_scope', message: `This Zernio key can't use ${err.requiredGroup ?? 'an area it needs'}. Create a key with Accounts and Publishing switched on.`, retryable: true };
    }
    if (code === 'ACCOUNT_DISCONNECTED') return { kind: 'reauth_account', message: ZERNIO_RECONNECT_MESSAGE, retryable: false };
    if (code === 'ACCOUNT_NOT_ENABLED_FOR_POSTING') return { kind: 'account_blocked', message: `Zernio says this TikTok account isn't enabled for posting.${said}`, retryable: true };
    if (code === 'PROFILE_OVER_LIMIT') return { kind: 'account_blocked', message: `Zernio says your plan's profile limit is reached.${said}`, retryable: true };
    // No code: the account id does not belong to this key (or is outside its profile scope).
    return { kind: 'reauth_account', message: ZERNIO_CHOOSE_AGAIN_MESSAGE, retryable: false };
  }
  if (status === 409) {
    if (typeof err.details['existingPostId'] === 'string') return { kind: 'duplicate', message: 'Zernio already has this video and caption for this account.', retryable: false };
    if (code === 'idempotency_conflict') return unclear('Zernio is still working on the first request.');
    return { kind: 'conflict', message: `Zernio couldn't post this right now.${said}`, retryable: true };
  }
  if (status === 429) {
    return options.afterCreate ? { kind: 'unknown', message: 'Zernio is limiting requests for a moment.', retryable: false } : { kind: 'rate_limited', message: 'Zernio is limiting requests for a moment.', retryable: true };
  }
  if (status === 404) return { kind: 'not_found', message: `Zernio couldn't find that.${said}`, retryable: false };
  if (status >= 500) return unclear(`Zernio had a temporary problem.${said}`);
  return { kind: 'refused', message: `Zernio refused this post.${said}`, retryable: true };
}
