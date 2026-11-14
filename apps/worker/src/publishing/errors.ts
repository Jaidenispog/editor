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
