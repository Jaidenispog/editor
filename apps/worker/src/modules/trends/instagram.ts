import { eq, sql } from 'drizzle-orm';
import { testOnlyBaseUrl } from '@studio/config';
import {
  HASHTAG_TOP_MEDIA_LIMIT,
  INSTAGRAM_HASHTAG_SOURCE_NAME,
  InstagramHashtagItemDataSchema,
  hashtagLimitMessage,
  instagramPostTitle,
  mayQueryHashtag,
  normaliseHashtag,
} from '@studio/core';
import { schema, type Database, type TrendWatch } from '@studio/db';
import type { WorkerContext } from '../../context.js';
import { decryptOptionalCredential } from '../../lib/credentials.js';
import { httpRequest, readJson } from '../../lib/http.js';
import { GRAPH_HOST, GraphApiError, appSecretProof, type GraphEnv } from '../../lib/meta/graph.js';
import { mapGraphError } from '../../publishing/errors.js';
import type { LiveTrendItemInput, TrendSourceOutcome, TrendSourceRefresher } from './sources.js';

/**
 * Instagram hashtag watch (WP5; preferences design §4.12 and §8.1, research memo §11). Reads `ig_hashtag_search` once
 * per hashtag, then `top_media` on every refresh, as the Instagram professional account the publishing module
 * connected, with that connection's encrypted system-user token (provider `meta`). Read-only: nothing is posted,
 * changed or deleted at Meta. Whether hashtag search is allowed for a Unified Login system-user configuration is not
 * known (memo §11 open question), so the first refresh of a hashtag is the capability check and "not available" is a
 * valid end state.
 */

/** Messages the owner sees (design §4.12 and §8.1). */
export const INSTAGRAM_HASHTAG_MESSAGES = {
  noAccount: 'Connect Instagram in Settings → Integrations first. Hashtag watch also needs the hashtag search permission on your Meta app.',
  reconnect: 'Reconnect Instagram in Settings → Integrations.',
  unavailable: "Your Meta app setup doesn't allow hashtag search. This is optional; everything else works.",
  slowDown: 'Instagram asked us to slow down; trying again tomorrow.',
  weeklyLimitAtInstagram: 'Instagram says this account has used its 30 hashtags for the week. It will try again tomorrow.',
  notFound: 'Instagram found no hashtag with that name.',
} as const;

/** Each Graph call gets this long (design §8: 15 s, no retries inside the handler). */
export const HASHTAG_CALL_TIMEOUT_MS = 15_000;

/** Fields requested from `top_media` (design §8.1; only these, never captions or media URLs). */
export const TOP_MEDIA_FIELDS = 'id,media_type,permalink,timestamp,like_count,comments_count';

/** Graph error codes that mean "too many requests" (memo §4, third-party code tables). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Key of the transaction-level advisory lock that serialises hashtag budget checks across workers. */
const BUDGET_LOCK_KEY = 5_050_301;

/**
 * The two hashtag reads. They use the publishing module's Graph host, version, `appsecret_proof` and
 * {@link GraphApiError}; the token goes in the `Authorization: Bearer` header (design §8.1), never in the URL, so it
 * cannot reach a log line even before redaction. Kept here because `MetaGraphClient` is owned by the publishing
 * package; see the integrator notes for moving these two methods into it.
 */
export class HashtagGraphReader {
  private readonly base: string;
  readonly version: string;

  constructor(
    private readonly ctx: Pick<WorkerContext, 'fetch' | 'logger'>,
    private readonly env: GraphEnv,
    private readonly token: string,
    private readonly signal?: AbortSignal,
  ) {
    this.base = testOnlyBaseUrl(env, env.META_GRAPH_BASE_URL) ?? GRAPH_HOST;
    this.version = env.META_GRAPH_VERSION;
  }

  private async get(path: string, params: Record<string, string>, label: string): Promise<Record<string, unknown>> {
    const q = new URLSearchParams(params);
    if (this.env.META_APP_SECRET) q.set('appsecret_proof', appSecretProof(this.env.META_APP_SECRET, this.token));
    const res = await httpRequest(
      this.ctx,
      `${this.base}/${this.version}/${path}?${q.toString()}`,
      { method: 'GET', headers: { authorization: `Bearer ${this.token}` } },
      { label, signal: this.signal, timeoutMs: HASHTAG_CALL_TIMEOUT_MS },
    );
    const body = (await readJson(res)) as Record<string, unknown> | null;
    if (res.ok && body && !body['error']) return body;
    const err = (body?.['error'] ?? {}) as Record<string, unknown>;
    const code = typeof err['code'] === 'number' ? err['code'] : null;
    const subcode = typeof err['error_subcode'] === 'number' ? err['error_subcode'] : null;
    const message = (typeof err['message'] === 'string' ? err['message'] : `${label} answered with HTTP ${res.status}`).slice(0, 500);
    const userMessage = typeof err['error_user_msg'] === 'string' ? err['error_user_msg'].slice(0, 500) : null;
    throw new GraphApiError(res.status, code, subcode, message, userMessage);
  }

  /** `GET /ig_hashtag_search?user_id={ig-user-id}&q={hashtag}` → hashtag ids (counts towards the weekly limit). */
  async searchHashtag(igUserId: string, hashtag: string): Promise<string[]> {
    const body = await this.get('ig_hashtag_search', { user_id: igUserId, q: hashtag }, 'meta.ig_hashtag_search');
    const data = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
    return data.map((d) => (typeof d['id'] === 'string' || typeof d['id'] === 'number' ? String(d['id']) : '')).filter((id) => /^\d{1,40}$/.test(id));
  }

  /** `GET /{ig-hashtag-id}/top_media?user_id=…&fields=…&limit=9`, as raw rows (parsed by {@link parseTopMedia}). */
  async topMedia(hashtagId: string, igUserId: string): Promise<unknown> {
    return this.get(`${encodeURIComponent(hashtagId)}/top_media`, { user_id: igUserId, fields: TOP_MEDIA_FIELDS, limit: String(HASHTAG_TOP_MEDIA_LIMIT) }, 'meta.hashtag_top_media');
  }
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Turns a `top_media` answer into items to store. Only the allowed fields survive; rows without an id or an
 * Instagram permalink are dropped; at most {@link HASHTAG_TOP_MEDIA_LIMIT} are kept, in Instagram's order.
 */
export function parseTopMedia(body: unknown, hashtag: string): LiveTrendItemInput[] {
  const rows = body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['data']) ? ((body as Record<string, unknown>)['data'] as unknown[]) : [];
  const tag = normaliseHashtag(hashtag);
  const out: LiveTrendItemInput[] = [];
  for (const raw of rows) {
    if (out.length >= HASHTAG_TOP_MEDIA_LIMIT) break;
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r['id'] === 'string' || typeof r['id'] === 'number' ? String(r['id']) : '';
    if (!/^\d{1,40}$/.test(id)) continue;
    const parsed = InstagramHashtagItemDataSchema.safeParse({
      provider: 'instagram_hashtag',
      hashtag: tag,
      rank: out.length + 1,
      mediaType: typeof r['media_type'] === 'string' && r['media_type'].trim() ? r['media_type'].trim().slice(0, 40) : 'UNKNOWN',
      postedAt: isoOrNull(r['timestamp']),
      likeCount: count(r['like_count']),
      commentsCount: count(r['comments_count']),
      permalink: typeof r['permalink'] === 'string' ? r['permalink'] : '',
    });
    if (!parsed.success) continue;
    out.push({
      externalId: id,
      title: instagramPostTitle(tag, parsed.data.mediaType, parsed.data.postedAt),
      category: 'other',
      sourceName: INSTAGRAM_HASHTAG_SOURCE_NAME,
      sourceUrl: parsed.data.permalink,
      data: parsed.data,
    });
  }
  return out;
}

/**
 * The outcome for a Graph refusal (design §8.1 table), or null when the job should throw and let pg-boss retry
 * (network failures, time-outs, 5xx and other temporary answers).
 */
export function hashtagErrorOutcome(err: unknown): Exclude<TrendSourceOutcome, { status: 'ok' }> | null {
  if (!(err instanceof GraphApiError)) return null;
  const text = `${err.message} ${err.userMessage ?? ''}`;
  if (err.code === 190) return { status: 'needs_reauth', message: INSTAGRAM_HASHTAG_MESSAGES.reconnect, reason: 'graph_190' };
  if (err.code !== null && RATE_LIMIT_CODES.has(err.code)) return { status: 'quota', message: INSTAGRAM_HASHTAG_MESSAGES.slowDown, reason: `graph_${err.code}` };
  if (/hashtag/i.test(text) && /\b30\b|unique hashtags|7[- ]day|seven days/i.test(text)) return { status: 'quota', message: INSTAGRAM_HASHTAG_MESSAGES.weeklyLimitAtInstagram, reason: 'hashtag_limit' };
  if (err.code === 10 || (err.code !== null && err.code >= 200 && err.code <= 299) || /permission|feature/i.test(text)) {
    return { status: 'unavailable', message: INSTAGRAM_HASHTAG_MESSAGES.unavailable, reason: err.code !== null ? `graph_${err.code}` : 'permission' };
  }
  const mapped = mapGraphError(err);
  if (mapped.kind === 'transient' || mapped.kind === 'not_ready') return null;
  if (mapped.kind === 'reauth') return { status: 'needs_reauth', message: INSTAGRAM_HASHTAG_MESSAGES.reconnect, reason: 'graph_reauth' };
  return { status: 'error', message: mapped.message.slice(0, 500), reason: err.code !== null ? `graph_${err.code}` : `http_${err.httpStatus}` };
}

/** Records the outcome of the capability check on the Instagram account (`capabilities.hashtagSearch`). */
async function recordHashtagCapability(db: Database, accountId: string, allowed: boolean): Promise<void> {
  const patch = { hashtagSearch: allowed, hashtagSearchCheckedAt: new Date().toISOString() };
  await db
    .update(schema.socialAccounts)
    .set({ capabilities: sql`${schema.socialAccounts.capabilities} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(schema.socialAccounts.id, accountId));
}

/** A query refused before any call because the weekly hashtag limit is used up. */
export type HashtagLimitRefusal = { status: 'quota'; message: string; reason: 'weekly_limit' };

/**
 * Records that a hashtag watch is about to query Instagram, within the weekly limit. Runs under a transaction-level
 * advisory lock so two workers cannot both take the 30th place. A hashtag already counted this week is always
 * allowed (it does not add to the count); a new one is refused with the date a place frees up. Returns `off` when
 * the watch was turned off meanwhile.
 */
export async function claimHashtagQuery(db: Database, watch: Pick<TrendWatch, 'id'>, now: Date = new Date()): Promise<'claimed' | 'off' | HashtagLimitRefusal> {
  const w = schema.trendWatches;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const rows = await tx.select({ id: w.id, enabled: w.enabled, lastQueriedAt: w.lastQueriedAt }).from(w).where(eq(w.provider, 'instagram_hashtag'));
    const self = rows.find((r) => r.id === watch.id);
    if (!self?.enabled) return 'off';
    const allowed = mayQueryHashtag(watch.id, rows, now);
    if (!allowed.ok) return { status: 'quota', message: hashtagLimitMessage(allowed.nextFreeAt), reason: 'weekly_limit' };
    await tx.update(w).set({ lastQueriedAt: now, updatedAt: now }).where(eq(w.id, watch.id));
    return 'claimed';
  });
}

/**
 * Reads one hashtag watch. Uses only the watch's own Instagram account and that account's `meta` connection; the
 * decrypted token lives only in this call. Refusals the owner must act on are returned as outcomes; temporary
 * failures throw so the job retries once after 5 minutes.
 */
export const refreshInstagramHashtag: TrendSourceRefresher = async (ctx, run, watch): Promise<TrendSourceOutcome> => {
  const account = watch.socialAccountId ? await ctx.db.query.socialAccounts.findFirst({ where: eq(schema.socialAccounts.id, watch.socialAccountId) }) : null;
  if (!account || account.platform !== 'instagram') return { status: 'error', message: INSTAGRAM_HASHTAG_MESSAGES.noAccount, reason: 'no_account' };
  if (account.status === 'needs_reauth') return { status: 'needs_reauth', message: INSTAGRAM_HASHTAG_MESSAGES.reconnect, reason: 'account_needs_reauth' };
  const conn = account.connectionId ? await ctx.db.query.integrationConnections.findFirst({ where: eq(schema.integrationConnections.id, account.connectionId) }) : null;
  if (conn?.status === 'needs_reauth') return { status: 'needs_reauth', message: INSTAGRAM_HASHTAG_MESSAGES.reconnect, reason: 'connection_needs_reauth' };
  const token = account.status === 'connected' && conn?.provider === 'meta' && conn.status === 'connected' ? decryptOptionalCredential(ctx.env, conn.accessTokenEncrypted) : null;
  if (!token) return { status: 'error', message: INSTAGRAM_HASHTAG_MESSAGES.noAccount, reason: 'no_connection' };

  const reader = new HashtagGraphReader(ctx, ctx.env, token, run.signal);
  try {
    let hashtagId = watch.externalId;
    if (!hashtagId) {
      const ids = await reader.searchHashtag(account.externalId, normaliseHashtag(watch.query));
      run.checkCancelled();
      hashtagId = ids[0] ?? null;
      if (!hashtagId) {
        await recordHashtagCapability(ctx.db, account.id, true);
        return { status: 'error', message: INSTAGRAM_HASHTAG_MESSAGES.notFound, reason: 'no_such_hashtag' };
      }
      await ctx.db.update(schema.trendWatches).set({ externalId: hashtagId, updatedAt: new Date() }).where(eq(schema.trendWatches.id, watch.id));
    }
    const body = await reader.topMedia(hashtagId, account.externalId);
    run.checkCancelled();
    await recordHashtagCapability(ctx.db, account.id, true);
    return { status: 'ok', items: parseTopMedia(body, watch.query) };
  } catch (err) {
    const outcome = hashtagErrorOutcome(err);
    if (!outcome) throw err;
    if (outcome.status === 'unavailable') await recordHashtagCapability(ctx.db, account.id, false);
    return outcome;
  }
};
