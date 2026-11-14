import 'server-only';
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  HASHTAG_WEEKLY_LIMIT,
  InstagramHashtagItemDataSchema,
  MAX_ENABLED_HASHTAGS,
  hashtagBudget,
  hashtagLimitMessage,
  hashtagProblem,
  instagramCountsLine,
  instagramMediaTypeLabel,
  mayQueryHashtag,
  newId,
  normaliseHashtag,
} from '@studio/core';
import { schema, type TrendWatch } from '@studio/db';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import type { ConnectionFacts } from './integrations/types.js';

/**
 * Instagram hashtag watch, web side (WP5; preferences design §4.12, §6.3 and §9.4). The owner adds a hashtag; the
 * worker's `trends.refresh` reads it through the Instagram account the publishing module connected. Adding one is
 * refused plainly when Instagram is not connected, when 10 hashtags are already watched, or when the weekly limit
 * of 30 hashtags is used up (the worker checks the limit again before every read, so this is only the first guard).
 * No token is read here.
 */

/** How much of the weekly hashtag limit is used, as the Settings card shows it. */
export interface HashtagBudgetDto {
  used: number;
  limit: number;
  /** Hashtags watched now, and the most the app watches at once. */
  enabled: number;
  maxEnabled: number;
  /** When a new hashtag can be added again, if the weekly limit is reached. */
  nextFreeAt: string | null;
}

/** The facts of one top post, exactly as Instagram reported them when it was fetched. */
export interface InstagramPostDto {
  itemId: string;
  rank: number;
  mediaType: string;
  mediaTypeLabel: string;
  postedAt: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  /** "120 likes · 4 comments", or empty when Instagram returned neither. */
  countsLine: string;
  permalink: string;
}

/** Instagram connection facts the hashtag card needs (never a credential). */
export async function loadInstagramFacts(): Promise<Pick<ConnectionFacts, 'connections' | 'socialAccounts'>> {
  const db = getDb();
  const c = schema.integrationConnections;
  const a = schema.socialAccounts;
  const [connections, socialAccounts] = await Promise.all([
    db.select({ provider: c.provider, status: c.status, displayName: c.displayName, lastError: c.lastError }).from(c).where(eq(c.provider, 'meta')),
    db.select({ platform: a.platform, status: a.status, username: a.username, capabilities: a.capabilities }).from(a).where(eq(a.platform, 'instagram')),
  ]);
  return { connections, socialAccounts };
}

/** The weekly budget and the enabled count, from every Instagram hashtag watch row. */
export function hashtagBudgetDto(watches: readonly TrendWatch[], now: Date = new Date()): HashtagBudgetDto {
  const rows = watches.filter((w) => w.provider === 'instagram_hashtag');
  const budget = hashtagBudget(rows, now);
  return { used: budget.used, limit: budget.limit, enabled: rows.filter((w) => w.enabled).length, maxEnabled: MAX_ENABLED_HASHTAGS, nextFreeAt: budget.nextFreeAt?.toISOString() ?? null };
}

/** The connected Instagram account hashtags are searched as, or a plain refusal. */
async function connectedInstagramAccount(): Promise<{ id: string }> {
  const env = getEnv();
  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.META_LOGIN_CONFIG_ID) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Instagram in Settings → Integrations first: the Meta app settings are not on the server yet.');
  }
  const db = getDb();
  const a = schema.socialAccounts;
  const accounts = await db
    .select({ id: a.id, status: a.status, connStatus: schema.integrationConnections.status, connProvider: schema.integrationConnections.provider })
    .from(a)
    .leftJoin(schema.integrationConnections, eq(schema.integrationConnections.id, a.connectionId))
    .where(eq(a.platform, 'instagram'))
    .orderBy(asc(a.createdAt));
  const usable = accounts.find((x) => x.status === 'connected' && x.connProvider === 'meta' && x.connStatus === 'connected');
  if (usable) return { id: usable.id };
  if (accounts.some((x) => x.status === 'needs_reauth' || x.connStatus === 'needs_reauth')) {
    throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Reconnect Instagram in Settings → Integrations first.');
  }
  throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Connect Instagram in Settings → Integrations first. Hashtag watch also needs the hashtag search permission on your Meta app.');
}

/**
 * Adds (or turns back on) a hashtag watch for the owner. Returns the row and whether a first read should be
 * queued. A hashtag that is already watched changes nothing.
 */
export async function addHashtagWatch(user: SessionUser, raw: string, now: Date = new Date()): Promise<{ watch: TrendWatch; queue: boolean }> {
  const problem = hashtagProblem(raw);
  if (problem) throw new AppError('VALIDATION', problem, { details: [{ path: 'hashtag', message: problem }] });
  const tag = normaliseHashtag(raw);
  const account = await connectedInstagramAccount();
  const db = getDb();
  const w = schema.trendWatches;
  const all = await db.select().from(w).where(eq(w.provider, 'instagram_hashtag'));
  const existing = all.find((x) => x.query === tag) ?? null;
  if (existing?.enabled) return { watch: existing, queue: false };

  const enabled = all.filter((x) => x.enabled).length;
  if (enabled >= MAX_ENABLED_HASHTAGS) {
    throw new AppError('CONFLICT', `You're watching ${MAX_ENABLED_HASHTAGS} hashtags, the most this app watches at once. Remove one first.`);
  }
  const allowed = mayQueryHashtag(existing?.id ?? '', all, now);
  if (!allowed.ok) {
    throw new AppError('RATE_LIMITED', hashtagLimitMessage(allowed.nextFreeAt), { details: { nextFreeAt: allowed.nextFreeAt.toISOString(), limit: HASHTAG_WEEKLY_LIMIT } });
  }

  const rows = await db
    .insert(w)
    .values({ id: newId(), provider: 'instagram_hashtag', query: tag, socialAccountId: account.id, enabled: true, status: 'pending', statusMessage: '', createdBy: user.id })
    .onConflictDoUpdate({ target: [w.provider, w.query], set: { enabled: true, status: 'pending', statusMessage: '', socialAccountId: account.id, updatedAt: now } })
    .returning();
  const watch = rows[0];
  if (!watch) throw new AppError('INTERNAL', 'The hashtag could not be added.');
  await writeAudit({ userId: user.id, action: 'trends.watch_added', entityType: 'trend_watch', entityId: watch.id, data: { provider: watch.provider, query: watch.query } });
  return { watch, queue: true };
}

/** The stored post facts of the given live items, by item id (rows that do not parse are left out). */
export async function loadInstagramPosts(watchIds: string[]): Promise<Map<string, InstagramPostDto>> {
  const out = new Map<string, InstagramPostDto>();
  if (!watchIds.length) return out;
  const r = schema.trendReferences;
  const rows = await getDb()
    .select({ id: r.id, data: r.data })
    .from(r)
    .where(and(eq(r.sourceKind, 'live'), inArray(r.watchId, watchIds)));
  for (const row of rows) {
    const parsed = InstagramHashtagItemDataSchema.safeParse(row.data);
    if (!parsed.success) continue;
    const d = parsed.data;
    out.set(row.id, {
      itemId: row.id,
      rank: d.rank,
      mediaType: d.mediaType,
      mediaTypeLabel: instagramMediaTypeLabel(d.mediaType),
      postedAt: d.postedAt,
      likeCount: d.likeCount,
      commentsCount: d.commentsCount,
      countsLine: instagramCountsLine(d.likeCount, d.commentsCount),
      permalink: d.permalink,
    });
  }
  return out;
}
