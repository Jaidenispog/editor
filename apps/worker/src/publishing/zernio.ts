import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Env } from '@studio/config';
import {
  CancelledError,
  PREFERENCES_RECOMPUTE_DELAY_SEC,
  PREFERENCES_RECOMPUTE_KEY,
  TIKTOK_INTERACTION_LABELS,
  ZERNIO_DAILY_VIDEO_CAP,
  ZERNIO_PUBLIC_PRIVACY,
  ZERNIO_UPLOAD_REUSE_MAX_SEC,
  ZernioConsentSchema,
  buildZernioCreateBody,
  computeTimeline,
  formatDateTime,
  manualStepMessage,
  methodVariantRefusal,
  validatePostLink,
  zernioBindingMatches,
  zernioLookupDelaySeconds,
  zernioPollDelaySeconds,
  type TargetStatus,
  type TiktokInteractions,
  type ZernioConsent,
} from '@studio/core';
import { schema } from '@studio/db';
import type { WorkerContext } from '../context.js';
import { writeWorkerAudit } from '../lib/audit.js';
import { recordConnectionCheck, type ConnectionRow } from '../lib/connections.js';
import { decryptOptionalCredential } from '../lib/credentials.js';
import { HttpTimeoutError, httpRequest, readJson } from '../lib/http.js';
import { enqueueTracked } from '../lib/jobs.js';
import { JobInterruptedError, stopOutcome, type TrackedRun } from '../lib/job-tracker.js';
import { resolveSafeAddress, systemResolver, type HostResolver } from '../website/ssrf.js';
import { ZERNIO_CHOOSE_AGAIN_MESSAGE, ZERNIO_KEY_REFUSED_MESSAGE, ZERNIO_RECONNECT_MESSAGE, ZernioApiError, mapZernioError } from './errors.js';
import { liveEligibility, recordPublishedEffects, refreshPostStatus, toManualStep, updateTarget, type PostRow, type TargetRow } from './post-status.js';


/**
 * TikTok automatic posting through Zernio (`method = zernio`, docs/design/publishing.md §7.2; every path, field and
 * header is quoted in docs/research/zernio-api.md). Behind `TIKTOK_PUBLISH_PROVIDER=zernio`; nothing here runs, and
 * no request is sent, while that flag is off.
 *
 * Duplicate protection (design §6.3 rule 4): the Zernio post id is saved as soon as a create answers; `submitted_at`
 * is set by a conditional update just before the create and is never followed by a second create unless the owner
 * chooses "It's not there – try again" (which reuses the same `Idempotency-Key`, so Zernio returns the original post
 * if it exists). After an unclear create the post is looked up read-only by `metadata.studioTargetId`. A failed post
 * is retried with `/v1/posts/{id}/retry`, never a new post. Webhooks only ever trigger a read.
 */

/** Statuses with which Zernio answers about a hinted post id itself; anything else keeps the hint (§7.2.5). */
const HINT_ANSWER_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);

/** The settings the adapter reads. */
export type ZernioEnv = Pick<Env, 'NODE_ENV' | 'TIKTOK_PUBLISH_PROVIDER' | 'ZERNIO_API_BASE_URL'>;

/** The create runs synchronously at Zernio (`publishNow`); its duration is undocumented, so it gets 10 minutes. */
export const CREATE_TIMEOUT_MS = 10 * 60_000;
/** The upload streams a whole export to Zernio's storage. */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;
/** "TikTok says this account can't post more right now": try again after this long. */
export const CAN_POST_MORE_RETRY_MINUTES = 30;
/**
 * Pages of `GET /v1/posts` one lookup reads (design §7.2.4 step 5d). The window is a few minutes of one studio's
 * posts, so one page is normal; past this bound the lookup counts as "not found" and the owner checks TikTok.
 */
export const ZERNIO_LOOKUP_MAX_PAGES = 10;

const ACTIVE: readonly TargetStatus[] = ['processing'];
const WAITING: readonly TargetStatus[] = ['processing', 'queued'];

/** True when automatic TikTok posting through Zernio is switched on and its API address is set. */
export function zernioEnabled(env: ZernioEnv): boolean {
  return env.TIKTOK_PUBLISH_PROVIDER === 'zernio' && Boolean(env.ZERNIO_API_BASE_URL);
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Upload transport (the presigned `uploadUrl` comes from a response, so it is treated as untrusted)
// ---------------------------------------------------------------------------------------------

/** Options for {@link putToUploadUrl}. */
export interface UploadOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  /**
   * Tests only: the one origin (the local fake standing in for Zernio) that may receive the upload over plain http on
   * 127.0.0.1. Built by {@link uploadTestOrigin}, which returns null unless NODE_ENV=test.
   */
  testOrigin?: string | null;
  resolver?: HostResolver;
}

/**
 * Tests only: when NODE_ENV=test and `ZERNIO_API_BASE_URL` itself is a loopback address (the local fake), uploads to
 * exactly that origin are allowed. Null in every other case, so a deployment always uses the strict rules.
 */
export function uploadTestOrigin(env: ZernioEnv): string | null {
  if (env.NODE_ENV !== 'test' || !env.ZERNIO_API_BASE_URL) return null;
  try {
    const u = new URL(env.ZERNIO_API_BASE_URL);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Why an upload address was refused before connecting. */
export class UploadAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadAddressError';
  }
}

/**
 * `PUT uploadUrl` with the file streamed and an explicit `Content-Length` (never chunked; design §7.2.4 step 4), the
 * same `Content-Type` as the presign and no `Authorization` header (zernio-api §5). HTTPS on port 443 only, no
 * credentials in the address, the host resolved and refused when any address is private or reserved, the connection
 * pinned to the checked address, and redirects never followed (a 3xx is returned as it is and treated as a refusal).
 */
export async function putToUploadUrl(uploadUrl: string, body: Readable, size: number, options: UploadOptions = {}): Promise<{ status: number; etag: string | null }> {
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw new UploadAddressError('Zernio gave an upload address that is not a valid link.');
  }
  const testHop = Boolean(options.testOrigin) && url.origin === options.testOrigin;
  if (!testHop) {
    if (url.protocol !== 'https:') throw new UploadAddressError('Zernio gave an upload address that is not https.');
    if (url.username || url.password || (url.port && url.port !== '443')) throw new UploadAddressError('Zernio gave an upload address on an unexpected port.');
  }
  const pinned = testHop ? { address: '127.0.0.1', family: 4 } : await resolveSafeAddress(url.hostname, { allowLoopback: false }, options.resolver ?? systemResolver);
  const lookup: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [pinned]);
    else cb(null, pinned.address, pinned.family);
  };
  const signal = options.signal;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new CancelledError('Stopped');
  const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  const secure = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const req = (secure ? https : http).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: 'PUT',
      headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      lookup,
      agent: false,
      ...(secure ? { servername: url.hostname } : {}),
    });
    const timer = setTimeout(() => {
      req.destroy();
      body.destroy();
      finish(() => reject(new HttpTimeoutError('zernio.upload', timeoutMs)));
    }, timeoutMs);
    const onAbort = () => {
      req.destroy();
      body.destroy();
      finish(() => reject(signal?.reason instanceof Error ? signal.reason : new CancelledError('Stopped during the upload')));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => finish(() => reject(err)));
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 502, etag: typeof res.headers.etag === 'string' ? res.headers.etag : null })));
      res.on('error', (err) => finish(() => reject(err)));
    });
    body.on('error', (err) => {
      req.destroy();
      finish(() => reject(err));
    });
    body.pipe(req);
  });
}

// ---------------------------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------------------------

/** One TikTok account as `GET /v1/accounts?platform=tiktok` lists it (zernio-api §4). */
export interface ZernioAccount {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
  needsReconnection: boolean;
  rateLimitedUntil: string | null;
  tiktokAccountType: string | null;
}

/** `GET /v1/accounts/{id}/health` facts (zernio-api §4). */
export interface ZernioHealth {
  integrationLane: string | null;
  status: string | null;
  tokenValid: boolean | null;
  canPost: boolean | null;
  missingRequired: string[];
}

/** `GET /v1/accounts/{id}/tiktok/creator-info?mediaType=video` facts (zernio-api §4, nested paths). */
export interface ZernioCreatorInfo {
  canPostMore: boolean | null;
  privacyLevels: string[];
  maxVideoDurationSec: number | null;
  interactions: Record<keyof TiktokInteractions, { enabled: boolean; default: boolean } | null>;
}

/** A raw answer of the create or retry call (the caller decides by status; 207 is a 2xx, zernio-api §6). */
export interface ZernioAnswer {
  status: number;
  body: Record<string, unknown>;
  retryAfterSec: number | null;
}

/** A client bound to one key and one run's AbortSignal. The key is only ever sent in the Authorization header. */
export class ZernioClient {
  private readonly base: string;

  constructor(
    private readonly ctx: Pick<WorkerContext, 'fetch' | 'logger'>,
    private readonly env: ZernioEnv,
    private readonly key: string,
    private readonly signal?: AbortSignal,
  ) {
    this.base = (env.ZERNIO_API_BASE_URL ?? '').replace(/\/+$/, '');
  }

  private async request(method: string, path: string, label: string, opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<ZernioAnswer> {
    const url = new URL(`${this.base}/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const res = await httpRequest(
      this.ctx,
      url.toString(),
      {
        method,
        headers: { authorization: `Bearer ${this.key}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      },
      { label, signal: this.signal, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) },
    );
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) this.ctx.logger.debug({ zernio: { label, rateLimitRemaining: remaining } }, 'zernio rate limit');
    const retryAfter = Number(res.headers.get('retry-after'));
    return { status: res.status, body: rec(await readJson(res)), retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 3600) : null };
  }

  /** The error for a non-success answer (never branches on the free-text `error`). */
  static errorOf(a: ZernioAnswer, label: string): ZernioApiError {
    const b = a.body;
    const message = (str(b['error']) ?? str(b['message']) ?? `${label} answered with HTTP ${a.status}`).slice(0, 500);
    return new ZernioApiError(a.status, str(b['type']), str(b['code']), message, rec(b['details']), a.retryAfterSec, str(b['required_group']) ?? str(rec(b['details'])['required_group']));
  }

  private async ok(method: string, path: string, label: string, opts: Parameters<ZernioClient['request']>[3] = {}): Promise<Record<string, unknown>> {
    const a = await this.request(method, path, label, opts);
    if (a.status >= 200 && a.status < 300) return a.body;
    throw ZernioClient.errorOf(a, label);
  }

  /** `GET /v1/auth/verify`: checks the key without reading any data. */
  async verify(): Promise<void> {
    await this.ok('GET', '/auth/verify', 'zernio.verify');
  }

  /** `GET /v1/accounts?platform=tiktok`. */
  async listTikTokAccounts(): Promise<ZernioAccount[]> {
    const body = await this.ok('GET', '/accounts', 'zernio.accounts', { query: { platform: 'tiktok' } });
    const list = Array.isArray(body['accounts']) ? body['accounts'] : [];
    return list
      .map(rec)
      .filter((a) => str(a['_id']) && (str(a['platform']) ?? 'tiktok') === 'tiktok')
      .map((a) => ({
        id: str(a['_id']) ?? '',
        username: (str(a['username']) ?? '').replace(/^@/, ''),
        displayName: str(a['displayName']) ?? '',
        isActive: a['isActive'] !== false,
        needsReconnection: a['needsReconnection'] === true,
        rateLimitedUntil: str(a['rateLimitedUntil']),
        tiktokAccountType: str(a['tiktokAccountType']),
      }));
  }

  /** `GET /v1/accounts/{id}/health`. */
  async health(accountId: string): Promise<ZernioHealth> {
    const b = await this.ok('GET', `/accounts/${encodeURIComponent(accountId)}/health`, 'zernio.health');
    const perms = rec(b['permissions']);
    return {
      integrationLane: str(b['integrationLane']),
      status: str(b['status']),
      tokenValid: bool(rec(b['tokenStatus'])['valid']),
      canPost: bool(perms['canPost']),
      missingRequired: Array.isArray(perms['missingRequired']) ? perms['missingRequired'].filter((x): x is string => typeof x === 'string') : [],
    };
  }

  /** `GET /v1/accounts/{id}/tiktok/creator-info?mediaType=video`. */
  async creatorInfo(accountId: string): Promise<ZernioCreatorInfo> {
    const b = await this.ok('GET', `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info`, 'zernio.creator_info', { query: { mediaType: 'video' } });
    const limits = rec(b['postingLimits']);
    const settings = rec(limits['interactionSettings']);
    const seed = (k: string) => {
      const d = settings[k];
      if (!d || typeof d !== 'object') return null;
      const r = rec(d);
      return { enabled: r['enabled'] === true, default: r['default'] === true };
    };
    return {
      canPostMore: bool(rec(b['creator'])['canPostMore']),
      privacyLevels: (Array.isArray(b['privacyLevels']) ? b['privacyLevels'] : []).map((p) => str(rec(p)['value']) ?? str(p)).filter((x): x is string => Boolean(x)),
      maxVideoDurationSec: num(limits['maxVideoDurationSec']),
      interactions: { allowComment: seed('allow_comment'), allowDuet: seed('allow_duet'), allowStitch: seed('allow_stitch') },
    };
  }

  /** `POST /v1/media/presign` → where to upload and the address the post will use. */
  async presign(input: { filename: string; size: number }): Promise<{ uploadUrl: string; publicUrl: string }> {
    const b = await this.ok('POST', '/media/presign', 'zernio.presign', { body: { filename: input.filename, contentType: 'video/mp4', size: input.size } });
    const uploadUrl = str(b['uploadUrl']);
    const publicUrl = str(b['publicUrl']);
    if (!uploadUrl || !publicUrl) throw new ZernioApiError(502, null, null, 'Zernio did not return an upload address.', {}, null, null);
    return { uploadUrl, publicUrl };
  }

  /** `POST /v1/posts` with `Idempotency-Key`; returns the raw answer (201, 200, 207 or an error status). */
  async createPost(body: ReturnType<typeof buildZernioCreateBody>, idempotencyKey: string): Promise<ZernioAnswer> {
    return this.request('POST', '/posts', 'zernio.create_post', { body, headers: { 'idempotency-key': idempotencyKey }, timeoutMs: CREATE_TIMEOUT_MS });
  }

  /** `GET /v1/posts/{id}` → the post. */
  async getPost(postId: string): Promise<Record<string, unknown>> {
    return rec((await this.ok('GET', `/posts/${encodeURIComponent(postId)}`, 'zernio.get_post'))['post']);
  }

  /**
   * `GET /v1/posts?updatedSince=…[&accountId=…]&fields=metadata,status,platforms[&cursor=…]`, following
   * `pagination.nextCursor` with the same filters (zernio-api §3: the 200 body is `{ posts, pagination }`, and with
   * `fields` "each post then carries `_id` plus only these fields"). Only listed parameters are sent (an unknown one is
   * a 400). Stops at the first item `match` accepts, at the last page, or after `maxPages` pages; null when not found.
   */
  async findRecentPost(input: { accountId: string | null; updatedSince: Date; maxPages?: number }, match: (post: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
    const query: Record<string, string> = { updatedSince: input.updatedSince.toISOString(), fields: 'metadata,status,platforms' };
    if (input.accountId) query['accountId'] = input.accountId;
    const seen = new Set<string>();
    for (let page = 0; page < (input.maxPages ?? ZERNIO_LOOKUP_MAX_PAGES); page++) {
      const b = await this.ok('GET', '/posts', 'zernio.list_posts', { query });
      const found = (Array.isArray(b['posts']) ? b['posts'] : []).map(rec).find(match);
      if (found) return found;
      const next = str(rec(b['pagination'])['nextCursor']);
      if (!next || seen.has(next)) return null;
      seen.add(next);
      query['cursor'] = next;
    }
    return null;
  }

  /** `POST /v1/posts/{id}/retry` (no body): re-runs only the failed platforms of a failed or partial post. */
  async retryPost(postId: string): Promise<ZernioAnswer> {
    return this.request('POST', `/posts/${encodeURIComponent(postId)}/retry`, 'zernio.retry_post');
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a post (pure)
// ---------------------------------------------------------------------------------------------

/** What a Zernio post read means for the target (design §7.2.4 step 6). */
export type ZernioReadOutcome =
  | { kind: 'published'; url: string | null; publishedAt: Date | null; removed: boolean }
  | { kind: 'draft_delivered' }
  | { kind: 'queued'; message: string }
  | { kind: 'processing'; message: string }
  | { kind: 'failed'; message: string; retryable: boolean; reauth: boolean };

/** The TikTok entry of a post (`post.platforms[]`), or null. */
export function tiktokEntry(post: Record<string, unknown>): Record<string, unknown> | null {
  const list = Array.isArray(post['platforms']) ? post['platforms'].map(rec) : [];
  return list.find((p) => p['platform'] === 'tiktok') ?? null;
}

/** Plain wording for the three entry errors the design names; everything else shows Zernio's own message. */
function entryFailure(entry: Record<string, unknown>): { message: string; retryable: boolean; reauth: boolean } {
  const text = str(entry['errorMessage']) ?? str(entry['error']) ?? '';
  const source = str(entry['errorSource']);
  const category = str(entry['errorCategory']);
  if (category === 'auth_expired' || /missing required tiktok permissions/i.test(text)) return { message: ZERNIO_RECONNECT_MESSAGE, retryable: false, reauth: true };
  if (/direct posting is at capacity/i.test(text)) return { message: 'TikTok is busy. Try again in a few hours, or send it to your drafts.', retryable: true, reauth: false };
  if (/too many posts in the last 24 hours/i.test(text)) return { message: "TikTok's own daily limit is reached. Try again tomorrow.", retryable: true, reauth: false };
  if (/pending drafts/i.test(text)) return { message: 'Finish or delete your TikTok drafts first.', retryable: false, reauth: false };
  const said = text ? ` TikTok said: ${text.slice(0, 300)}` : '';
  return { message: `TikTok didn't publish this.${said}`, retryable: source === 'platform' || source === 'system', reauth: false };
}

/**
 * Maps a post read (or a create answer's `post`) to the target's next state. A delivered draft is entry `published`
 * with no URL; which key marks it on a read is unconfirmed (zernio-api §8), so either key counts, and so does our own
 * `delivery = draft`. A URL is used only from `platformPostUrl` and only when it is a real TikTok post link; a draft
 * counts as published only once it has such a link (any other address, a profile link say, keeps it a draft).
 */
export function mapZernioPost(post: Record<string, unknown>, delivery: 'publish' | 'draft', options: { dailyCapReached?: boolean } = {}): ZernioReadOutcome {
  const status = str(post['status']);
  const entry = tiktokEntry(post) ?? {};
  const entryStatus = str(entry['status']);
  if (status === 'draft' || status === 'pending_approval') return { kind: 'failed', message: 'Zernio saved this without posting it. Nothing went to TikTok.', retryable: false, reauth: false };
  if (status === 'cancelled' || entryStatus === 'cancelled') return { kind: 'failed', message: 'Cancelled inside Zernio.', retryable: false, reauth: false };
  if (entryStatus === 'published') {
    const psd = rec(entry['platformSpecificData']);
    const isDraft = psd['isDraft'] === true || rec(psd['tiktokSettings'])['draft'] === true || delivery === 'draft';
    const rawUrl = str(entry['platformPostUrl']);
    // Decided on the validated link, never the raw field: an inbox draft must never show as published.
    const url = rawUrl ? validatePostLink('tiktok', rawUrl) : null;
    if (isDraft && !url) return { kind: 'draft_delivered' };
    const at = str(entry['publishedAt']);
    return { kind: 'published', url, publishedAt: at && Number.isFinite(Date.parse(at)) ? new Date(at) : null, removed: Boolean(entry['removedFromPlatformAt']) };
  }
  if (entryStatus === 'failed' || (status === 'failed' && entryStatus !== 'processing' && entryStatus !== 'uploading')) {
    const f = entryFailure(entry);
    return { kind: 'failed', ...f };
  }
  if (status === 'scheduled' || entryStatus === 'pending') {
    return {
      kind: 'queued',
      message: options.dailyCapReached ? "TikTok's daily limit is reached; Zernio will post it when allowed." : 'Waiting at Zernio. It retries temporary problems and holds posts over TikTok’s daily limit.',
    };
  }
  return { kind: 'processing', message: 'TikTok is processing the video (this can take up to 48 hours).' };
}

// ---------------------------------------------------------------------------------------------
// Target helpers
// ---------------------------------------------------------------------------------------------

type AccountRow = typeof schema.socialAccounts.$inferSelect;
type Loaded = { ok: true; client: ZernioClient; account: AccountRow; conn: ConnectionRow } | { ok: false; reason: string };

async function projectOf(ctx: WorkerContext, postId: string): Promise<string | null> {
  const p = await ctx.db.query.publishPosts.findFirst({ columns: { projectId: true }, where: eq(schema.publishPosts.id, postId) });
  return p?.projectId ?? null;
}

/** The Zernio connection and the target's account with a client, or why they cannot be used. No side effects. */
async function loadClient(ctx: WorkerContext, run: TrackedRun, target: TargetRow): Promise<Loaded> {
  if (!zernioEnabled(ctx.env)) return { ok: false, reason: 'flag_off' };
  const account = target.accountId ? await ctx.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, target.accountId) }) : null;
  const conn = account?.connectionId ? await ctx.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, account.connectionId) }) : null;
  const key = conn && conn.provider === 'zernio' && conn.status !== 'disconnected' ? decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted) : null;
  if (!account || !conn || !key) return { ok: false, reason: 'no_connection' };
  return { ok: true, client: new ZernioClient(ctx, ctx.env, key, run.signal), account, conn };
}

async function schedulePoll(ctx: WorkerContext, target: TargetRow, pollNo: number, delaySec: number): Promise<void> {
  await enqueueTracked(
    ctx,
    'publish.poll',
    { targetId: target.id, postId: target.postId, projectId: await projectOf(ctx, target.postId), pollNo },
    { singletonKey: `publish-poll:${target.id}`, startAfter: new Date(Date.now() + delaySec * 1000) },
  );
}

async function requeueTarget(ctx: WorkerContext, target: TargetRow, at: Date, message: string): Promise<void> {
  await updateTarget(ctx.db, target.id, ACTIVE, { status: 'queued', statusMessage: message.slice(0, 500), providerState: { nextAttemptAt: at.toISOString() } });
  await enqueueTracked(ctx, 'publish.target', { targetId: target.id, postId: target.postId, projectId: await projectOf(ctx, target.postId) }, { singletonKey: `publish-target:${target.id}`, startAfter: at });
  await refreshPostStatus(ctx.db, target.postId);
}

async function failTarget(ctx: WorkerContext, target: TargetRow, from: readonly TargetStatus[], message: string, retryable: boolean, extra: Parameters<typeof updateTarget>[3] = {}): Promise<void> {
  const { providerState, ...rest } = extra;
  const done = await updateTarget(ctx.db, target.id, from, { ...rest, status: 'failed', statusMessage: message.slice(0, 500), error: message.slice(0, 500), providerState: { ...(providerState ?? {}), retryable } });
  if (done) await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.failed', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', method: 'zernio' } }, ctx.logger);
  await refreshPostStatus(ctx.db, target.postId);
}

async function markAccount(ctx: WorkerContext, accountId: string, status: 'needs_reauth' | 'error' | 'connected', message: string | null): Promise<void> {
  await ctx.db
    .update(schema.socialAccounts)
    .set({ status, lastError: message ? message.slice(0, 500) : null, lastCheckedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.socialAccounts.id, accountId), inArray(schema.socialAccounts.status, ['connected', 'needs_reauth', 'error'])));
}

async function toReconnect(ctx: WorkerContext, target: TargetRow, accountId: string, accountMessage: string, from: readonly TargetStatus[] = ACTIVE, extra: Parameters<typeof updateTarget>[3] = {}): Promise<void> {
  await markAccount(ctx, accountId, 'needs_reauth', accountMessage);
  await toManualStep(ctx.db, target.id, from, 'reconnect_account', `${accountMessage} Or post it yourself.`.slice(0, 500), extra);
  await refreshPostStatus(ctx.db, target.postId);
}

/** Our own Zernio videos for an account in the last 24 hours (the composer's "n of 15" and the held-post wording). */
export async function zernioVideosLast24h(ctx: Pick<WorkerContext, 'db'>, accountRowId: string, now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000);
  const t = schema.publishTargets;
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(and(eq(t.method, 'zernio'), eq(t.accountId, accountRowId), eq(t.delivery, 'publish'), inArray(t.status, ['published', 'processing', 'queued']), gte(t.submittedAt, since)));
  return rows[0]?.n ?? 0;
}

/** The interactions to send: the owner's choice, with anything TikTok has since turned off sent as false. */
function finalInteractions(choice: TiktokInteractions, info: ZernioCreatorInfo): { interactions: TiktokInteractions; turnedOff: string[] } {
  const out = { ...choice };
  const turnedOff: string[] = [];
  for (const k of ['allowComment', 'allowDuet', 'allowStitch'] as const) {
    const d = info.interactions[k];
    if (out[k] && d && !d.enabled) {
      out[k] = false;
      turnedOff.push(TIKTOK_INTERACTION_LABELS[k]);
    }
  }
  return { interactions: out, turnedOff };
}

/** The approval as stored on the target and whether the target still matches it. */
function boundConsent(target: TargetRow, post: PostRow, account: AccountRow): ZernioConsent | null {
  const parsed = ZernioConsentSchema.safeParse(target.providerState['consent']);
  if (!parsed.success) return null;
  const c = parsed.data;
  const now = { caption: post.caption, coverTimeSec: post.coverTimeSec, variant: target.mediaVariant, delivery: target.delivery, accountRowId: account.id, handle: account.username, interactions: c.binding.interactions };
  return zernioBindingMatches(c.binding, now) ? c : null;
}

// ---------------------------------------------------------------------------------------------
// Applying a read to the target
// ---------------------------------------------------------------------------------------------

/**
 * Applies what Zernio reports now (design §7.2.4 step 6). Events can reverse (a published target reported failed by
 * Zernio's reconciliation, or the other way round): the target follows Zernio, the change is audited as
 * `publish.target.reconciled`, and no link is ever invented. A target the owner confirmed by hand is left alone.
 * Returns true when polling can stop.
 */
async function applyRead(ctx: WorkerContext, target: TargetRow, post: Record<string, unknown>): Promise<boolean> {
  if (target.confirmedAt) return true;
  const capReached = target.accountId ? (await zernioVideosLast24h(ctx, target.accountId)) >= ZERNIO_DAILY_VIDEO_CAP : false;
  const outcome = mapZernioPost(post, target.delivery, { dailyCapReached: capReached });
  const from: TargetStatus[] = ['processing', 'queued', 'published', 'failed', 'manual_step_required'];
  const zernioStatus = { zernioStatus: str(post['status']), zernioEntryStatus: str(tiktokEntry(post)?.['status']) };
  let final = false;
  switch (outcome.kind) {
    case 'published': {
      const url = outcome.url ?? target.publishedUrl;
      const message = url
        ? `Published ${formatDateTime(outcome.publishedAt ?? target.publishedAt ?? new Date(), { dateStyle: undefined, timeStyle: 'short' })}${outcome.removed ? '. Removed from TikTok since.' : ''}`
        : 'Published. The TikTok link appears in a few minutes.';
      const updated = await updateTarget(ctx.db, target.id, from, {
        status: 'published',
        manualStep: null,
        publishedUrl: url,
        publishedAt: target.publishedAt ?? outcome.publishedAt ?? new Date(),
        statusMessage: message,
        error: null,
        providerState: zernioStatus,
      });
      if (updated && target.status !== 'published') {
        if (target.status === 'failed') await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.reconciled', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', from: target.status, to: 'published' } }, ctx.logger);
        await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.published', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', method: 'zernio', variant: target.mediaVariant, postId: target.postId } }, ctx.logger);
        const postRow = await ctx.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, target.postId) });
        if (postRow) await recordPublishedEffects(ctx.db, updated, postRow, postRow.approvedBy);
        try {
          await enqueueTracked(ctx, 'preferences.recompute', { reason: 'feedback' }, { singletonKey: PREFERENCES_RECOMPUTE_KEY, startAfterSeconds: PREFERENCES_RECOMPUTE_DELAY_SEC });
        } catch (err) {
          ctx.logger.warn({ err, targetId: target.id }, 'could not queue a preferences recompute; the nightly run will catch up');
        }
      }
      final = Boolean(url);
      break;
    }
    case 'draft_delivered':
      if (target.status === 'published') {
        final = true;
        break;
      }
      await toManualStep(ctx.db, target.id, ['processing', 'queued'], 'finish_in_tiktok_app', manualStepMessage('finish_in_tiktok_app', 'tiktok'), { providerState: zernioStatus });
      final = true;
      break;
    case 'queued':
      await updateTarget(ctx.db, target.id, WAITING, { status: 'queued', statusMessage: outcome.message, providerState: zernioStatus });
      break;
    case 'processing':
      await updateTarget(ctx.db, target.id, WAITING, { status: 'processing', statusMessage: outcome.message, providerState: zernioStatus });
      break;
    case 'failed': {
      if (target.status === 'published') await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.reconciled', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', from: 'published', to: 'failed' } }, ctx.logger);
      if (outcome.reauth && target.accountId) {
        await markAccount(ctx, target.accountId, 'needs_reauth', ZERNIO_RECONNECT_MESSAGE);
        await toManualStep(ctx.db, target.id, ['processing', 'queued', 'published'], 'reconnect_account', `${ZERNIO_RECONNECT_MESSAGE} Then press Retry, or post it yourself.`, { providerState: { ...zernioStatus, retryable: true } });
      } else if (target.status !== 'failed' || target.statusMessage !== outcome.message) {
        await failTarget(ctx, target, ['processing', 'queued', 'published', 'failed'], outcome.message, outcome.retryable, { providerState: zernioStatus });
      }
      final = true;
      break;
    }
  }
  await refreshPostStatus(ctx.db, target.postId);
  return final;
}

/** Saves the Zernio post id the moment it is known (a retry then never creates again). */
async function savePostId(ctx: WorkerContext, target: TargetRow, postId: string): Promise<TargetRow> {
  const saved = await updateTarget(ctx.db, target.id, ['processing', 'queued', 'manual_step_required', 'failed'], { externalPostId: postId, providerState: { zernioLookupAttempt: null, zernioHintPostId: null, zernioHintVerified: null } });
  return saved ?? { ...target, externalPostId: postId };
}

/**
 * Next scheduled read, or the end of the 50-hour window (design §7.2.4 step 6). The schedule's last read is at the
 * window's end itself, so "no next read" always means the window is over: a target still `processing` or `queued`
 * (held at Zernio) then becomes the owner's check, and nothing is left waiting with no read scheduled.
 */
async function scheduleNextRead(ctx: WorkerContext, target: TargetRow, pollNo: number): Promise<void> {
  const since = (target.submittedAt ?? target.updatedAt).getTime();
  const delay = zernioPollDelaySeconds((Date.now() - since) / 1000);
  if (delay !== null) {
    await updateTarget(ctx.db, target.id, ['processing', 'queued', 'published'], { providerState: { lastPollNo: pollNo } });
    return schedulePoll(ctx, target, pollNo + 1, delay);
  }
  const fresh = (await ctx.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, target.id) })) ?? target;
  if (fresh.status === 'published') {
    await updateTarget(ctx.db, target.id, ['published'], { statusMessage: 'Published. Open TikTok to see it, or paste the link.' });
    return;
  }
  if (fresh.status === 'processing' || fresh.status === 'queued') {
    await toManualStep(ctx.db, target.id, WAITING, 'check_before_retry', "TikTok still hasn't confirmed this after two days. Check your TikTok profile first.");
    await refreshPostStatus(ctx.db, target.postId);
  }
}

/** Starts the read-only lookup after an unclear create (step 5d): `submitted_at` stays, and no second create is sent. */
async function startLookup(ctx: WorkerContext, target: TargetRow, waitSec: number): Promise<void> {
  await updateTarget(ctx.db, target.id, WAITING, { status: 'processing', statusMessage: 'Checking with Zernio whether TikTok received this…', providerState: { zernioLookupAttempt: 0 } });
  await schedulePoll(ctx, target, 0, zernioLookupDelaySeconds(0, waitSec) ?? 60);
}

// ---------------------------------------------------------------------------------------------
// publish.target
// ---------------------------------------------------------------------------------------------

/**
 * Runs a claimed Zernio target from wherever it stopped (design §7.2.4). The caller has set it to `processing`.
 */
export async function runZernioTarget(ctx: WorkerContext, run: TrackedRun, target: TargetRow, post: PostRow): Promise<void> {
  const loaded = await loadClient(ctx, run, target);
  if (!loaded.ok) {
    if (loaded.reason === 'flag_off') {
      await failTarget(ctx, target, ACTIVE, 'Automatic TikTok posting is switched off on this server. Post it yourself.', true);
    } else {
      await toManualStep(ctx.db, target.id, ACTIVE, 'reconnect_account', manualStepMessage('reconnect_account', 'tiktok'));
      await refreshPostStatus(ctx.db, target.postId);
    }
    return;
  }
  const { client, account } = loaded;

  // A post already exists at Zernio: never create again. A failed one is retried in place.
  if (target.externalPostId) return await continueExistingPost(ctx, run, client, target);
  // Sent before, outcome unknown: look it up read-only, never a new create.
  if (target.submittedAt) return await startLookup(ctx, target, 0);

  if (account.status !== 'connected') {
    await toManualStep(ctx.db, target.id, ACTIVE, 'reconnect_account', `${account.lastError ?? ZERNIO_RECONNECT_MESSAGE} Or post it yourself.`.slice(0, 500));
    await refreshPostStatus(ctx.db, target.postId);
    return;
  }
  const caps = account.capabilities;
  const verified = Boolean(caps[target.delivery === 'draft' ? 'verifiedDraftAt' : 'verifiedDirectAt']);
  const switchedOn = target.delivery === 'draft' ? caps['draftsEnabled'] === true : account.directPublishEnabled;
  if (!target.isVerification && (!verified || !switchedOn)) {
    const what = target.delivery === 'draft' ? 'Sending to TikTok drafts' : 'Publishing via Zernio';
    await failTarget(ctx, target, ACTIVE, verified ? `${what} is switched off in Settings → Integrations. Post it yourself, or switch it on and retry.` : `${what} isn't switched on yet. Make its first verification post, or post it yourself.`, verified);
    return;
  }
  const consent = boundConsent(target, post, account);
  if (!consent) {
    await failTarget(ctx, target, ACTIVE, 'Nothing was sent: this TikTok post changed after you approved it, or it was approved without the consent tick. Make the post again and approve it.', false);
    return;
  }
  if (!target.mediaKey) {
    await failTarget(ctx, target, ACTIVE, "The video file isn't ready. Press Retry to prepare it again.", true);
    return;
  }
  // The licence as it is now must still allow this exact file.
  const live = await liveEligibility(ctx.db, post.editVersionId, ['tiktok']);
  const e = live?.eligibility.perPlatform[0];
  const refusal = !e ? 'This version no longer exists.' : methodVariantRefusal(e, 'zernio', target.mediaVariant);
  if (refusal) {
    await toManualStep(ctx.db, target.id, ACTIVE, 'music_licence_changed', manualStepMessage('music_licence_changed', 'tiktok'), { error: refusal.slice(0, 500) });
    await refreshPostStatus(ctx.db, target.postId);
    return;
  }
  const durationSec = live?.plan ? computeTimeline(live.plan).totalDurationSec : null;

  let submitted = false;
  let fresh: TargetRow = target;
  try {
    // --- Pre-flight (read-only).
    let health: ZernioHealth;
    try {
      health = await client.health(account.externalId);
    } catch (err) {
      if (err instanceof ZernioApiError && (err.httpStatus === 404 || (err.httpStatus === 403 && (err.code === 'ACCOUNT_DISCONNECTED' || !err.code)))) {
        return await toReconnect(ctx, target, account.id, err.code === 'ACCOUNT_DISCONNECTED' ? ZERNIO_RECONNECT_MESSAGE : ZERNIO_CHOOSE_AGAIN_MESSAGE);
      }
      throw err;
    }
    if (health.integrationLane !== 'business') return await toReconnect(ctx, target, account.id, 'Reconnect TikTok inside Zernio to move it to the Business connection.');
    if (health.canPost !== true || health.tokenValid === false) return await toReconnect(ctx, target, account.id, ZERNIO_RECONNECT_MESSAGE);
    const listed = (await client.listTikTokAccounts()).find((a) => a.id === account.externalId);
    if (!listed) return await toReconnect(ctx, target, account.id, ZERNIO_CHOOSE_AGAIN_MESSAGE);
    if (!listed.isActive || listed.needsReconnection) return await toReconnect(ctx, target, account.id, ZERNIO_RECONNECT_MESSAGE);
    const cooldown = listed.rateLimitedUntil ? Date.parse(listed.rateLimitedUntil) : NaN;
    if (Number.isFinite(cooldown) && cooldown > Date.now()) {
      const at = new Date(cooldown + 30_000);
      return await requeueTarget(ctx, target, at, `Zernio is pausing posts to this account for a while; trying again at ${formatDateTime(at, { dateStyle: undefined, timeStyle: 'short' })}.`);
    }
    const info = await client.creatorInfo(account.externalId);
    if (!info.privacyLevels.includes(ZERNIO_PUBLIC_PRIVACY)) return await failTarget(ctx, target, ACTIVE, "TikTok doesn't allow public posts from this account right now. Post it yourself.", false);
    if (durationSec !== null && info.maxVideoDurationSec !== null && durationSec > info.maxVideoDurationSec + 0.5) {
      return await failTarget(ctx, target, ACTIVE, `This video is longer than TikTok allows for this account (${info.maxVideoDurationSec} seconds). Post it yourself.`, false);
    }
    if (info.canPostMore === false) {
      const at = new Date(Date.now() + CAN_POST_MORE_RETRY_MINUTES * 60_000);
      return await requeueTarget(ctx, target, at, `TikTok says this account can't post more right now; trying again at ${formatDateTime(at, { dateStyle: undefined, timeStyle: 'short' })}.`);
    }
    const { interactions, turnedOff } = finalInteractions(consent.binding.interactions, info);
    run.checkCancelled();

    // --- Upload (no post exists yet, so this may repeat freely).
    let mediaUrl = str(fresh.providerState['zernioMediaUrl']);
    const uploadedAt = Date.parse(String(fresh.providerState['zernioMediaUploadedAt'] ?? ''));
    if (!mediaUrl || !Number.isFinite(uploadedAt) || Date.now() - uploadedAt > ZERNIO_UPLOAD_REUSE_MAX_SEC * 1000) {
      const stat = await ctx.store.stat(target.mediaKey);
      if (!stat) return await failTarget(ctx, target, ACTIVE, 'The video file is missing from storage. Press Retry to prepare it again.', true, { mediaKey: null });
      await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'Uploading to Zernio…' });
      await run.progress(0.3, 'Uploading to Zernio…');
      mediaUrl = null;
      for (let attempt = 0; attempt < 2 && !mediaUrl; attempt++) {
        const slot = await client.presign({ filename: `${target.id}.mp4`, size: stat.size });
        const put = await putToUploadUrl(slot.uploadUrl, await ctx.store.getStream(target.mediaKey), stat.size, { signal: run.signal, testOrigin: uploadTestOrigin(ctx.env) });
        if (put.status >= 200 && put.status < 300) mediaUrl = slot.publicUrl;
        else ctx.logger.warn({ targetId: target.id, status: put.status, attempt }, 'zernio storage refused the upload');
      }
      if (!mediaUrl) throw new ZernioApiError(503, null, null, "Zernio's storage did not accept the upload.", {}, null, null);
      fresh = (await updateTarget(ctx.db, target.id, ACTIVE, { providerState: { zernioMediaUrl: mediaUrl, zernioMediaUploadedAt: new Date().toISOString() } })) ?? fresh;
      run.checkCancelled();
    }

    // --- Create: re-read and re-check the approval, then mark the one non-repeatable call.
    const reread = await ctx.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, target.id) });
    const repost = await ctx.db.query.publishPosts.findFirst({ where: eq(schema.publishPosts.id, post.id) });
    const reacct = await ctx.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, account.id) });
    if (!reread || !repost || !reacct || repost.status === 'cancelled' || !repost.approvedAt || !boundConsent(reread, repost, reacct) || reacct.externalId !== account.externalId) {
      return await failTarget(ctx, target, ACTIVE, 'Nothing was sent: this TikTok post or its account changed after you approved it. Make the post again and approve it.', false);
    }
    const marked = (
      await ctx.db
        .update(schema.publishTargets)
        .set({
          submittedAt: new Date(),
          statusMessage: target.delivery === 'draft' ? 'Sending to your TikTok drafts…' : 'Publishing to TikTok…',
          providerState: sql`${schema.publishTargets.providerState} || ${JSON.stringify({ submittedAccountId: account.externalId, sentInteractions: interactions })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.publishTargets.id, target.id), eq(schema.publishTargets.status, 'processing'), isNull(schema.publishTargets.submittedAt)))
        .returning()
    )[0];
    if (!marked) return;
    submitted = true;
    fresh = marked;
    await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.submitted', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', method: 'zernio', variant: target.mediaVariant, delivery: target.delivery } }, ctx.logger);
    const body = buildZernioCreateBody({ targetId: target.id, caption: repost.caption, mediaUrl, zernioAccountId: account.externalId, interactions, coverTimeSec: repost.coverTimeSec, delivery: target.delivery });
    const answer = await client.createPost(body, target.id);
    await handleCreateAnswer(ctx, client, marked, account, answer, turnedOff);
  } catch (err) {
    const latest = (await ctx.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, target.id) })) ?? fresh;
    if (err instanceof CancelledError || err instanceof JobInterruptedError) {
      if (submitted) {
        await startLookup(ctx, latest, 0);
        throw err;
      }
      const outcome = await stopOutcome(run);
      if (outcome !== 'resume') await failTarget(ctx, latest, ACTIVE, 'Stopped before anything was sent to TikTok. Press Retry.', true);
      throw err;
    }
    if (submitted) {
      const mapped = mapZernioError(err, { afterCreate: true });
      if (mapped.kind === 'unknown') return await startLookup(ctx, latest, err instanceof ZernioApiError ? (err.retryAfterSec ?? 0) : 0);
      throw err;
    }
    await applyFailure(ctx, run, latest, account, err);
  }
}

/** A failure before anything was sent: retry transient ones, settle everything else with a plain message. */
async function applyFailure(ctx: WorkerContext, run: TrackedRun, target: TargetRow, account: AccountRow, err: unknown): Promise<void> {
  const mapped = mapZernioError(err);
  if (err instanceof ZernioApiError) {
    if (mapped.kind === 'rate_limited') {
      const at = new Date(Date.now() + (err.retryAfterSec ?? 60) * 1000);
      return requeueTarget(ctx, target, at, `Zernio is limiting requests for a moment; trying again at ${formatDateTime(at, { dateStyle: undefined, timeStyle: 'short' })}.`);
    }
    if (mapped.kind !== 'transient') return settleRefusal(ctx, target, account, mapped.kind, mapped.message, mapped.retryable);
  }
  if (err instanceof Error && err.name === 'UploadAddressError') return failTarget(ctx, target, ACTIVE, `${err.message} Nothing was sent. Post it yourself, or try again later.`, true);
  if (err instanceof Error && err.name === 'BlockedHostError') return failTarget(ctx, target, ACTIVE, 'Zernio gave an upload address that points to a private network, so nothing was sent.', true);
  if (run.willRetry) {
    await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: `${mapped.message} Trying again shortly.`.slice(0, 500) });
  } else {
    await failTarget(ctx, target, ACTIVE, `${mapped.message} Nothing was sent. Press Retry.`, true);
  }
  throw err;
}

/**
 * A refusal (an error that proves nothing was created): the target settles, and `submitted_at` is cleared so the
 * owner's Retry sends one create again (with the same `Idempotency-Key`). Every 400 also discards the upload, because
 * an expired upload answers 400 without a documented code (zernio-api §5), so Retry uploads again first.
 */
async function settleRefusal(ctx: WorkerContext, target: TargetRow, account: AccountRow, kind: string, message: string, retryable: boolean): Promise<void> {
  const clear = { submittedAt: null, providerState: kind === 'refused' ? { zernioMediaUrl: null, zernioMediaUploadedAt: null, retryable } : { retryable } };
  switch (kind) {
    case 'reauth_key':
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'needs_reauth', lastError: ZERNIO_KEY_REFUSED_MESSAGE }, new Date(), { unlessDisconnected: true });
      await markAccount(ctx, account.id, 'needs_reauth', ZERNIO_KEY_REFUSED_MESSAGE);
      await toManualStep(ctx.db, target.id, ACTIVE, 'reconnect_account', `${ZERNIO_KEY_REFUSED_MESSAGE} Or post it yourself.`, clear);
      break;
    case 'reauth_account':
      await markAccount(ctx, account.id, 'needs_reauth', message);
      await toManualStep(ctx.db, target.id, ACTIVE, 'reconnect_account', `${message} Or post it yourself.`.slice(0, 500), clear);
      break;
    case 'key_scope':
    case 'account_blocked':
    case 'billing':
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'error', lastError: message }, new Date(), { unlessDisconnected: true });
      await failTarget(ctx, target, ACTIVE, message, true, clear);
      return;
    case 'conflict': {
      await failTarget(ctx, target, ACTIVE, `${message} Press Retry later, or post it yourself.`, true, clear);
      const conn = await ctx.db.query.integrationConnections.findFirst({ columns: { id: true }, where: eq(schema.integrationConnections.provider, 'zernio') });
      await enqueueTracked(ctx, 'social.check', { connectionId: conn?.id ?? null, reason: 'pre_publish' }, { singletonKey: `social-check:${conn?.id ?? 'all'}` });
      return;
    }
    case 'not_found':
      await toReconnect(ctx, target, account.id, ZERNIO_CHOOSE_AGAIN_MESSAGE, ACTIVE, clear);
      return;
    default:
      await failTarget(ctx, target, ACTIVE, `${message} Press Retry to upload it again, or post it yourself.`.slice(0, 500), retryable, clear);
      return;
  }
  await refreshPostStatus(ctx.db, target.postId);
}

/** Step 5c: what the create answered. */
async function handleCreateAnswer(ctx: WorkerContext, client: ZernioClient, target: TargetRow, account: AccountRow, answer: ZernioAnswer, turnedOff: string[]): Promise<void> {
  const note = turnedOff.length ? ` ${turnedOff.join(' and ')} ${turnedOff.length === 1 ? 'was' : 'were'} turned off in your TikTok settings, so ${turnedOff.length === 1 ? 'it was' : 'they were'} sent as off.` : '';
  if (answer.status === 200 || answer.status === 201 || answer.status === 207) {
    const post = rec(answer.body['post']);
    const id = str(post['_id']);
    if (!id) return startLookup(ctx, target, 0);
    const saved = await savePostId(ctx, target, id);
    if (note) await updateTarget(ctx.db, target.id, WAITING, { providerState: { interactionNote: note.trim() } });
    if (answer.status === 207 && str(post['status']) === 'scheduled') {
      await updateTarget(ctx.db, target.id, WAITING, { status: 'queued', statusMessage: 'Zernio hit a temporary problem and will retry by itself.' });
      await refreshPostStatus(ctx.db, target.postId);
      return schedulePoll(ctx, saved, 0, 60);
    }
    const final = await applyRead(ctx, saved, post);
    if (!final) await schedulePoll(ctx, saved, 0, 60);
    return;
  }
  const err = ZernioClient.errorOf(answer, 'zernio.create_post');
  const mapped = mapZernioError(err, { afterCreate: true });
  if (mapped.kind === 'duplicate') {
    const existingId = str(err.details['existingPostId']) ?? '';
    let existing: Record<string, unknown> | null = null;
    try {
      existing = await client.getPost(existingId);
    } catch {
      existing = null;
    }
    if (existing && rec(existing['metadata'])['studioTargetId'] === target.id) {
      const saved = await savePostId(ctx, target, existingId);
      const final = await applyRead(ctx, saved, existing);
      if (!final) await schedulePoll(ctx, saved, 0, 60);
      return;
    }
    return failTarget(ctx, target, ACTIVE, `Zernio refused: this video and caption already went to @${account.username} in the last 24 hours.`, false, { submittedAt: null });
  }
  if (mapped.kind === 'unknown') return startLookup(ctx, target, err.retryAfterSec ?? 0);
  return settleRefusal(ctx, target, account, mapped.kind, mapped.message, mapped.retryable);
}

/** Step 2 and step 7: a post already exists. A failed or partial one is retried in place; otherwise it is read. */
async function continueExistingPost(ctx: WorkerContext, run: TrackedRun, client: ZernioClient, target: TargetRow): Promise<void> {
  const postId = target.externalPostId ?? '';
  try {
    const post = await client.getPost(postId);
    const status = str(post['status']);
    if (status !== 'failed' && status !== 'partial') {
      const final = await applyRead(ctx, target, post);
      if (!final) await schedulePoll(ctx, target, 0, 60);
      return;
    }
    await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.submitted', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', method: 'zernio', retry: true } }, ctx.logger);
    const answer = await client.retryPost(postId);
    if (answer.status === 200 || answer.status === 207) {
      const final = await applyRead(ctx, target, rec(answer.body['post']));
      if (!final) await schedulePoll(ctx, target, 0, 60);
      return;
    }
    const err = ZernioClient.errorOf(answer, 'zernio.retry_post');
    if (answer.status === 409) {
      await updateTarget(ctx.db, target.id, ACTIVE, { statusMessage: 'TikTok is processing the video.' });
      return schedulePoll(ctx, target, 0, 60);
    }
    if (answer.status === 422) return failTarget(ctx, target, ACTIVE, "Zernio no longer keeps this video, so it can't try again. Post it yourself.", false);
    if (answer.status === 402) {
      const message = 'Zernio says the last payment failed. Fix it in Zernio, then try again.';
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'error', lastError: message }, new Date(), { unlessDisconnected: true });
      return failTarget(ctx, target, ACTIVE, message, true);
    }
    if (answer.status === 429) {
      const at = new Date(Date.now() + (answer.retryAfterSec ?? 60) * 1000);
      return requeueTarget(ctx, target, at, `Zernio is limiting requests for a moment; trying again at ${formatDateTime(at, { dateStyle: undefined, timeStyle: 'short' })}.`);
    }
    throw err;
  } catch (err) {
    if (err instanceof CancelledError || err instanceof JobInterruptedError) throw err;
    const mapped = mapZernioError(err);
    if (mapped.kind === 'transient') {
      if (!run.willRetry) await failTarget(ctx, target, ACTIVE, `${mapped.message} Press Retry: it reads the post at Zernio first, so nothing is posted twice.`, true);
      throw err;
    }
    if (mapped.kind === 'reauth_key') {
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'needs_reauth', lastError: ZERNIO_KEY_REFUSED_MESSAGE }, new Date(), { unlessDisconnected: true });
    }
    await failTarget(ctx, target, ACTIVE, `${mapped.message} Press Retry later, or check your TikTok profile.`.slice(0, 500), mapped.kind !== 'not_found');
  }
}

// ---------------------------------------------------------------------------------------------
// publish.poll
// ---------------------------------------------------------------------------------------------

/**
 * `publish.poll` for a Zernio target: reads the post (or, after an unclear create, looks it up by its metadata) and
 * schedules the next read until the target settles. Only reads. `hint` marks a read a webhook asked for (design
 * §7.2.5): in lookup mode it tries the hinted post and the list once, but never uses up or reschedules one of the
 * 1/2/5/10-minute lookups, and it is the only read a target waiting for the owner's check (`check_before_retry`,
 * no post id) still takes, so a genuine late event can still adopt the post before the owner sends it again.
 */
export async function runZernioPoll(ctx: WorkerContext, run: TrackedRun, target: TargetRow, pollNo: number, options: { hint?: boolean } = {}): Promise<void> {
  if (target.confirmedAt || target.status === 'cancelled') return;
  if (!target.externalPostId && !target.submittedAt) return;
  if (target.status === 'manual_step_required' && target.manualStep !== 'check_before_retry' && target.manualStep !== 'finish_in_tiktok_app') return;
  const loaded = await loadClient(ctx, run, target);
  if (!loaded.ok) {
    await updateTarget(ctx.db, target.id, WAITING, { statusMessage: "TikTok's status can't be checked until Zernio is connected again." });
    return;
  }
  const { client, account } = loaded;
  try {
    if (target.externalPostId) {
      const post = await client.getPost(target.externalPostId);
      const final = await applyRead(ctx, target, post);
      if (!final) {
        const fresh = (await ctx.db.query.publishTargets.findFirst({ where: eq(schema.publishTargets.id, target.id) })) ?? target;
        if (fresh.status === 'processing' || fresh.status === 'queued' || fresh.status === 'published') await scheduleNextRead(ctx, fresh, pollNo);
      }
      return;
    }
    const hintMode = options.hint === true;
    const awaitingCheck = target.status === 'manual_step_required' && target.manualStep === 'check_before_retry';
    if (target.status !== 'processing' && !(hintMode && awaitingCheck)) return;
    const submittedAccount = str(target.providerState['submittedAccountId']);
    // Ours only when Zernio's own read-back carries our metadata AND its TikTok entry is on our account (the one in
    // use now, or the one the create went to). An entry without an account is never ours.
    const isOurs = (p: Record<string, unknown>): boolean => {
      if (rec(p['metadata'])['studioTargetId'] !== target.id) return false;
      const entry = tiktokEntry(p);
      const entryAccount = entry ? (str(entry['accountId']) ?? str(rec(entry['accountId'])['_id'])) : null;
      return entryAccount !== null && (entryAccount === account.externalId || entryAccount === submittedAccount);
    };
    // Lookup mode (step 5d): first the webhook's hint, read back by id and adopted only when it is ours (§7.2.5),
    // then the account's recent posts.
    const hint = str(target.providerState['zernioHintPostId']);
    if (hint) {
      let hinted: Record<string, unknown> | null = null;
      // Zernio answered about this id (a post, or 400/404/410/422 for an id it does not know or accept): read, so
      // dropped unless ours. Any other failure (5xx, network, 429, or 401/402/403 about the key or the account) says
      // nothing about the id, so the hint is kept for the next read; the list lookup still runs.
      let answered = true;
      try {
        hinted = await client.getPost(hint);
      } catch (err) {
        if (err instanceof CancelledError || err instanceof JobInterruptedError) throw err;
        answered = err instanceof ZernioApiError && HINT_ANSWER_STATUSES.has(err.httpStatus);
      }
      if (hinted && isOurs(hinted)) return await adoptFound(ctx, target, hint, hinted);
      if (answered) await clearHint(ctx, target.id, hint);
    }
    // A webhook-triggered read of a target waiting for the owner's check also runs the bounded, read-only metadata
    // lookup once: the hint it read may have been a forged or stale id, while the genuine post is in Zernio's list.
    // It never uses up or schedules a lookup (the scheduled ones are over); a scheduled poll never reaches here.
    if (awaitingCheck && !hintMode) return;
    const since = new Date((target.submittedAt?.getTime() ?? Date.now()) - 2 * 60_000);
    const found = await client.findRecentPost(
      { accountId: submittedAccount && submittedAccount === account.externalId ? submittedAccount : null, updatedSince: since },
      (p) => Boolean(str(p['_id'])) && (hintMode ? isOurs(p) : rec(p['metadata'])['studioTargetId'] === target.id),
    );
    if (found) return await adoptFound(ctx, target, str(found['_id']) ?? '', found);
    // A webhook-triggered read never uses up a lookup or schedules one: the scheduled lookup poll is still queued.
    if (hintMode) return;
    const attempt = Number(target.providerState['zernioLookupAttempt'] ?? 0) + 1;
    const delay = zernioLookupDelaySeconds(attempt);
    if (delay === null) {
      await toManualStep(ctx.db, target.id, ACTIVE, 'check_before_retry', manualStepMessage('check_before_retry', 'tiktok'), { providerState: { zernioLookupAttempt: null } });
      await refreshPostStatus(ctx.db, target.postId);
      return;
    }
    await updateTarget(ctx.db, target.id, ACTIVE, { providerState: { zernioLookupAttempt: attempt } });
    await schedulePoll(ctx, target, pollNo + 1, delay);
  } catch (err) {
    if (err instanceof CancelledError || err instanceof JobInterruptedError) throw err;
    const mapped = mapZernioError(err);
    if (mapped.kind === 'reauth_key') {
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'needs_reauth', lastError: ZERNIO_KEY_REFUSED_MESSAGE }, new Date(), { unlessDisconnected: true });
      await updateTarget(ctx.db, target.id, WAITING, { statusMessage: "TikTok's status can't be checked until Zernio accepts the key again." });
      return;
    }
    if (mapped.kind === 'not_found' && target.externalPostId) {
      await failTarget(ctx, target, ['processing', 'queued'], 'Zernio no longer has this post. Check your TikTok profile, or post it yourself.', false);
      return;
    }
    throw err;
  }
}

async function adoptFound(ctx: WorkerContext, target: TargetRow, postId: string, post: Record<string, unknown>): Promise<void> {
  // Found while waiting for the owner's check: Zernio has the post, so it is read again from here, never sent again.
  if (target.status === 'manual_step_required') {
    const resumed = await updateTarget(ctx.db, target.id, ['manual_step_required'], {
      status: 'processing',
      manualStep: null,
      externalPostId: postId,
      statusMessage: 'Zernio has this post. Checking its status with TikTok…',
      providerState: { zernioLookupAttempt: null, zernioHintPostId: null, zernioHintVerified: null },
    });
    if (!resumed) return;
    await writeWorkerAudit(ctx.db, { userId: null, action: 'publish.target.reconciled', entityType: 'publish_target', entityId: target.id, data: { platform: 'tiktok', from: 'check_before_retry', to: 'processing' } }, ctx.logger);
    target = resumed;
  }
  const saved = await savePostId(ctx, target, postId);
  const full = Array.isArray(post['platforms']) ? post : null;
  const final = full ? await applyRead(ctx, saved, full) : false;
  if (!final) await schedulePoll(ctx, saved, 0, 60);
}

// ---------------------------------------------------------------------------------------------
// social.check (read-only)
// ---------------------------------------------------------------------------------------------

/** One candidate account as stored in the connection's config for the owner to choose from. */
export interface ZernioCandidate {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
  needsReconnection: boolean;
  rateLimitedUntil: string | null;
  tiktokAccountType: string | null;
  integrationLane: string | null;
  canPost: boolean | null;
  tokenValid: boolean | null;
  /** Why it cannot be used for automatic posting (plain), or null. */
  problem: string | null;
}

function candidateProblem(a: ZernioAccount, h: ZernioHealth | null): string | null {
  if (!h) return ZERNIO_RECONNECT_MESSAGE;
  if (!a.isActive || a.needsReconnection || h.tokenValid === false || h.canPost === false) return ZERNIO_RECONNECT_MESSAGE;
  if (h.integrationLane !== 'business') return 'Reconnect TikTok inside Zernio to move it to the Business connection.';
  return null;
}

/**
 * Zernio's read-only check (design §7.2.1): the key (`/v1/auth/verify`), the TikTok accounts and each one's health
 * (lane, token, posting permission), and creator info for the chosen account (the review card's switches). Never
 * posts and never changes anything at Zernio. Records the outcome on the connection and the chosen account.
 */
export async function checkZernio(ctx: WorkerContext, run: TrackedRun, conn: ConnectionRow): Promise<string> {
  if (conn.status === 'disconnected') return 'Zernio is disconnected';
  if (!zernioEnabled(ctx.env)) return 'Automatic TikTok posting is switched off on this server';
  const key = decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted);
  if (!key) return 'No Zernio key to check';
  const client = new ZernioClient(ctx, ctx.env, key, run.signal);
  const accountsT = schema.socialAccounts;
  const stored = await ctx.db.query.socialAccounts.findMany({ where: and(eq(accountsT.provider, 'zernio'), eq(accountsT.platform, 'tiktok'), or(eq(accountsT.connectionId, conn.id), isNull(accountsT.connectionId))) });
  const live = stored.filter((s) => s.status !== 'disconnected');
  try {
    await client.verify();
    const accounts = await client.listTikTokAccounts();
    run.checkCancelled();
    const candidates: ZernioCandidate[] = [];
    for (const a of accounts.slice(0, 10)) {
      let h: ZernioHealth | null = null;
      try {
        h = await client.health(a.id);
      } catch (err) {
        // Only an answer about the account itself (404, or a 403 other than the key's missing group) makes it a
        // candidate with a problem. Anything else, a 429 rate limit included, says nothing about the account: the
        // check stops and runs again, so nobody is told to reconnect because of rate limiting.
        const aboutAccount = err instanceof ZernioApiError && (err.httpStatus === 404 || (err.httpStatus === 403 && err.code !== 'insufficient_permissions'));
        if (!aboutAccount) throw err;
      }
      candidates.push({ ...a, integrationLane: h?.integrationLane ?? null, canPost: h?.canPost ?? null, tokenValid: h?.tokenValid ?? null, problem: candidateProblem(a, h) });
    }
    await ctx.db
      .update(schema.integrationConnections)
      .set({ config: sql`${schema.integrationConnections.config} || ${JSON.stringify({ candidates, candidatesCheckedAt: new Date().toISOString() })}::jsonb`, updatedAt: new Date() })
      .where(and(eq(schema.integrationConnections.id, conn.id), sql`${schema.integrationConnections.status} <> 'disconnected'`));
    for (const s of live) {
      const c = candidates.find((x) => x.id === s.externalId);
      if (!c) {
        await markAccount(ctx, s.id, 'needs_reauth', ZERNIO_CHOOSE_AGAIN_MESSAGE);
        continue;
      }
      const capabilities: Record<string, boolean | string | number | null> = {
        businessApiLane: c.integrationLane === 'business',
        integrationLane: c.integrationLane,
        canPost: c.canPost,
        rateLimitedUntil: c.rateLimitedUntil,
        tiktokAccountType: c.tiktokAccountType,
      };
      if (!c.problem) {
        const info = await client.creatorInfo(c.id);
        for (const k of ['allowComment', 'allowDuet', 'allowStitch'] as const) {
          const d = info.interactions[k];
          capabilities[`${k}Enabled`] = d ? d.enabled : false;
          capabilities[`${k}Default`] = d ? d.default : false;
        }
        capabilities['privacyPublicAllowed'] = info.privacyLevels.includes(ZERNIO_PUBLIC_PRIVACY);
        capabilities['maxVideoDurationSec'] = info.maxVideoDurationSec;
        capabilities['canPostMore'] = info.canPostMore;
        capabilities['creatorInfoCheckedAt'] = new Date().toISOString();
      }
      await ctx.db
        .update(accountsT)
        .set({
          username: c.username || s.username,
          displayName: c.displayName,
          status: c.problem ? 'needs_reauth' : 'connected',
          lastError: c.problem,
          lastCheckedAt: new Date(),
          capabilities: sql`${accountsT.capabilities} || ${JSON.stringify(capabilities)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(accountsT.id, s.id), inArray(accountsT.status, ['connected', 'needs_reauth', 'error'])));
    }
    if (accounts.length === 0) {
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'error', lastError: 'Connect TikTok inside Zernio first, then press Check connection.', capabilities: { tiktokAccounts: 0 } }, new Date(), { unlessDisconnected: true });
      return 'No TikTok account in Zernio';
    }
    const names = accounts.map((a) => `@${a.username || a.id}`);
    await recordConnectionCheck(ctx.db, 'zernio', { status: 'connected', lastError: null, displayName: names.join(', '), capabilities: { tiktokAccounts: accounts.length } }, new Date(), { unlessDisconnected: true });
    return `Checked Zernio: ${names.join(', ')}`;
  } catch (err) {
    if (err instanceof CancelledError || err instanceof JobInterruptedError) throw err;
    const mapped = mapZernioError(err);
    if (mapped.kind === 'transient' || mapped.kind === 'rate_limited') throw err;
    if (mapped.kind === 'reauth_key') {
      await recordConnectionCheck(ctx.db, 'zernio', { status: 'needs_reauth', lastError: ZERNIO_KEY_REFUSED_MESSAGE }, new Date(), { unlessDisconnected: true });
      for (const s of live) await markAccount(ctx, s.id, 'needs_reauth', ZERNIO_KEY_REFUSED_MESSAGE);
      return 'Zernio refused the key';
    }
    await recordConnectionCheck(ctx.db, 'zernio', { status: 'error', lastError: mapped.message }, new Date(), { unlessDisconnected: true });
    return 'Zernio check failed';
  }
}

// ---------------------------------------------------------------------------------------------
// Webhooks (hints only)
// ---------------------------------------------------------------------------------------------

/**
 * The `zernio` webhook handler (design §7.2.5). The stored envelope is only a hint: the target is found by
 * `metadata.studioTargetId` first, then by the post id against `external_post_id`, and the only effect is a read
 * (`publish.poll`) with our own key. A forged or replayed event can at most cause one read-back plus, at "check before retry", one bounded (≤ 10 pages) read-only list lookup per hint read.
 */
export async function handleZernioWebhook(ctx: WorkerContext, _run: TrackedRun, event: { payload: Record<string, unknown>; signatureValid: boolean }): Promise<void> {
  const env = event.payload;
  const name = str(env['event']) ?? '';
  if (name === 'account.disconnected') {
    const conn = await ctx.db.query.integrationConnections.findFirst({ columns: { id: true, status: true }, where: eq(schema.integrationConnections.provider, 'zernio') });
    if (conn && conn.status !== 'disconnected') await enqueueTracked(ctx, 'social.check', { connectionId: conn.id, reason: 'manual' }, { singletonKey: `social-check:${conn.id}` });
    return;
  }
  const t = schema.publishTargets;
  const studioTargetId = str(env['studioTargetId']);
  const postId = str(env['postId']);
  let target: TargetRow | undefined;
  if (studioTargetId) target = await ctx.db.query.publishTargets.findFirst({ where: and(eq(t.id, studioTargetId), eq(t.method, 'zernio')) });
  if (!target && postId) target = await ctx.db.query.publishTargets.findFirst({ where: and(eq(t.platform, 'tiktok'), eq(t.method, 'zernio'), eq(t.externalPostId, postId)) });
  if (!target || target.confirmedAt || target.status === 'cancelled') return;
  if (!target.externalPostId && !target.submittedAt) return;
  // Outcome unknown (no post id yet): the hinted id is kept for a read-back, also once the target waits for the owner's
  // check, so a genuine late event can still prevent a second send. It is adopted only if the read-back matches, and
  // an unverified id never replaces a verified one that has not been read yet (storeHint).
  const lookingUp = target.status === 'processing' || (target.status === 'manual_step_required' && target.manualStep === 'check_before_retry');
  if (!target.externalPostId && postId && lookingUp) await storeHint(ctx, target.id, postId.slice(0, 64), event.signatureValid === true);
  await enqueueTracked(
    ctx,
    'publish.poll',
    { targetId: target.id, postId: target.postId, projectId: await projectOf(ctx, target.postId), pollNo: Number(target.providerState['lastPollNo'] ?? 0), hint: true },
    { singletonKey: `publish-poll-hint:${target.id}` },
  );
}

/** Waiting for an id: no post id yet, and the create's outcome is still being looked up or waits for the owner. */
function awaitingPostId() {
  const t = schema.publishTargets;
  return and(isNull(t.externalPostId), or(eq(t.status, 'processing'), and(eq(t.status, 'manual_step_required'), eq(t.manualStep, 'check_before_retry'))));
}

/**
 * Keeps a webhook's post id for the next read-back, in one conditional update so concurrent deliveries cannot race:
 * a verified id always replaces the stored one, an unverified id only replaces another unverified one (or none). So a
 * forged or unsigned event can never push out a genuine event's id before it is read. `updated_at` is left alone: a
 * hint is not progress, and forged deliveries must not keep a lost target looking alive to the dispatch net.
 */
async function storeHint(ctx: WorkerContext, targetId: string, postId: string, verified: boolean): Promise<void> {
  const t = schema.publishTargets;
  const patch = JSON.stringify({ zernioHintPostId: postId, zernioHintVerified: verified });
  await ctx.db
    .update(t)
    .set({ providerState: sql`${t.providerState} || ${patch}::jsonb` })
    .where(and(eq(t.id, targetId), awaitingPostId(), verified ? undefined : sql`coalesce(${t.providerState}->>'zernioHintVerified', 'false') <> 'true'`));
}

/** Drops a hint that was read and is not ours, unless a newer hint has replaced it meanwhile (that one is still unread). */
async function clearHint(ctx: WorkerContext, targetId: string, postId: string): Promise<void> {
  const t = schema.publishTargets;
  await ctx.db
    .update(t)
    .set({ providerState: sql`(${t.providerState} - 'zernioHintPostId') - 'zernioHintVerified'` })
    .where(and(eq(t.id, targetId), sql`${t.providerState}->>'zernioHintPostId' = ${postId}`));
}
