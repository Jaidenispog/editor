import 'server-only';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  AppError,
  CuratedTrendDataSchema,
  NotedTrendDataSchema,
  NotedTrendPlatformSchema,
  TREND_TITLE_MAX,
  TrendCategorySchema,
  YouTubeChartItemDataSchema,
  isCuratedDueForReview,
  isLiveTrendStale,
  isMelbourneDate,
  melbourneDateOf,
  newId,
  trendLabel,
  youTubeCategoryName,
  type NotedTrendPlatform,
  type TrendCategory,
  type TrendSourceKind,
} from '@studio/core';
import { schema } from '@studio/db';
import { z } from 'zod';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';

/**
 * Trend references for Settings → Trends: three groups that are never mixed (live signals, noted by staff, curated
 * references). Every item's label comes from `trendLabel`, so nothing is ever called "trending". None of this is
 * passed to the edit planners; "Use as idea" only copies text the owner can see into the clipboard.
 */

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Links must start with http:// or https://');

/** Body for POST /api/trends. References added here are always curated (clients cannot choose the kind). */
export const CreateTrendSchema = z.object({
  title: z.string().trim().min(1, 'Add a title').max(TREND_TITLE_MAX),
  summary: z.string().trim().max(2000).default(''),
  category: TrendCategorySchema.default('format'),
  sourceName: z.string().trim().min(1, 'Say where this reference comes from').max(160),
  sourceUrl: httpUrl.default(''),
  enabled: z.boolean().default(true),
});

/** Body for PUT /api/trends: id plus any fields to change (including the enabled flag). Curated references only. */
export const UpdateTrendSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(TREND_TITLE_MAX).optional(),
  summary: z.string().trim().max(2000).optional(),
  category: TrendCategorySchema.optional(),
  sourceName: z.string().trim().min(1).max(160).optional(),
  sourceUrl: httpUrl.optional(),
  enabled: z.boolean().optional(),
  /** Marks the reference as reviewed today ("Mark reviewed"). */
  markVerified: z.boolean().optional(),
});

/** Body for POST /api/trends/notes ("Note a trend"; any signed-in user). */
export const NoteTrendSchema = z.object({
  title: z.string().trim().min(1, 'Say what you saw').max(TREND_TITLE_MAX),
  summary: z.string().trim().max(2000).default(''),
  platform: NotedTrendPlatformSchema,
  sourceUrl: httpUrl.default(''),
  seenOn: z
    .string()
    .refine(isMelbourneDate, 'Use a real date')
    .refine((d) => d <= melbourneDateOf(new Date()), 'The date can’t be in the future'),
  category: TrendCategorySchema.default('format'),
});

/** One curated source of a reference (a format may come from several). */
export interface TrendSource {
  name: string;
  url: string;
}

/** A trend item as sent to the browser. `label` always comes from `trendLabel`. */
export interface TrendItemDto {
  id: string;
  kind: TrendSourceKind;
  title: string;
  summary: string;
  category: TrendCategory;
  label: string;
  sourceName: string;
  sourceUrl: string;
  /** Curated: when it was last reviewed; live: when it was fetched; noted: when it was noted. */
  lastVerifiedAt: string;
  enabled: boolean;
  /** Curated with no source link: shown as "Editor suggestion — no external source". */
  editorSuggestion: boolean;
  /** Curated: last reviewed 180 or more days ago. */
  dueForReview: boolean;
  /** Curated: every source it was collected from. */
  sources: TrendSource[];
  /** Live: the watch it belongs to, when it was fetched and whether it is out of date. */
  watchId: string | null;
  fetchedAt: string | null;
  stale: boolean;
  /** Live (YouTube chart): channel, category name and chart position. */
  channelTitle: string | null;
  categoryName: string | null;
  position: number | null;
  /** Noted: where and when it was seen, and who noted it. */
  platform: NotedTrendPlatform | null;
  seenOn: string | null;
  notedById: string | null;
  notedByName: string | null;
}

/** Kept for existing imports: a trend reference as sent to the browser. */
export type TrendSummary = TrendItemDto;

type TrendRow = typeof schema.trendReferences.$inferSelect;

/** Builds the browser shape of one row. Pure apart from `now`, so labels are unit tested through it. */
export function toTrendItemDto(r: TrendRow, notedByName: string | null, now: Date = new Date()): TrendItemDto {
  const base: TrendItemDto = {
    id: r.id,
    kind: r.sourceKind,
    title: r.title,
    summary: r.summary,
    category: r.category,
    label: '',
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    lastVerifiedAt: r.lastVerifiedAt.toISOString(),
    enabled: r.enabled,
    editorSuggestion: false,
    dueForReview: false,
    sources: [],
    watchId: r.watchId,
    fetchedAt: r.fetchedAt?.toISOString() ?? null,
    stale: false,
    channelTitle: null,
    categoryName: null,
    position: null,
    platform: null,
    seenOn: null,
    notedById: r.notedBy,
    notedByName: null,
  };
  if (r.sourceKind === 'live') {
    const yt = YouTubeChartItemDataSchema.safeParse(r.data);
    const fetchedAt = r.fetchedAt ?? r.lastVerifiedAt;
    const hashtag = (r.data as { provider?: unknown; hashtag?: unknown }).provider === 'instagram_hashtag' ? (r.data as { hashtag?: unknown }).hashtag : undefined;
    return {
      ...base,
      label: typeof hashtag === 'string' ? trendLabel({ kind: 'live', provider: 'instagram_hashtag', hashtag, fetchedAt }) : trendLabel({ kind: 'live', provider: 'youtube_chart', fetchedAt }),
      fetchedAt: fetchedAt.toISOString(),
      stale: isLiveTrendStale(r.staleAfter, now),
      channelTitle: yt.success ? yt.data.channelTitle : null,
      categoryName: yt.success ? youTubeCategoryName(yt.data.categoryId) : null,
      position: yt.success ? yt.data.position : null,
    };
  }
  if (r.sourceKind === 'noted') {
    const noted = NotedTrendDataSchema.safeParse(r.data);
    const seenOn = noted.success ? noted.data.seenOn : melbourneDateOf(r.createdAt);
    const platform = noted.success ? noted.data.platform : null;
    return {
      ...base,
      label: trendLabel({ kind: 'noted', notedByName: notedByName ?? '', seenOn, platform }),
      platform,
      seenOn,
      notedByName,
    };
  }
  const curated = CuratedTrendDataSchema.safeParse(r.data);
  const sources = curated.success && curated.data.sources.length ? curated.data.sources : r.sourceUrl ? [{ name: r.sourceName, url: r.sourceUrl }] : [];
  return {
    ...base,
    label: trendLabel({ kind: 'curated', sourceName: r.sourceName, sourceUrl: r.sourceUrl, lastReviewedAt: r.lastVerifiedAt }),
    editorSuggestion: !r.sourceUrl.trim(),
    dueForReview: isCuratedDueForReview(r.lastVerifiedAt, now),
    sources,
  };
}

/** Every curated, noted and live item, each group in its own order (curated: in use first, then A–Z). */
export async function listTrends(now: Date = new Date()): Promise<TrendItemDto[]> {
  const r = schema.trendReferences;
  const w = schema.trendWatches;
  const rows = await getDb()
    .select({ row: r, notedByName: schema.users.displayName, watchEnabled: w.enabled })
    .from(r)
    .leftJoin(schema.users, eq(schema.users.id, r.notedBy))
    .leftJoin(w, eq(w.id, r.watchId))
    .orderBy(desc(r.enabled), asc(r.title));
  const items = rows.filter((x) => x.row.sourceKind !== 'live' || x.watchEnabled === true).map((x) => toTrendItemDto(x.row, x.notedByName, now));
  const curated = items.filter((i) => i.kind === 'curated');
  const noted = items.filter((i) => i.kind === 'noted').sort((a, b) => (b.seenOn ?? '').localeCompare(a.seenOn ?? '') || b.lastVerifiedAt.localeCompare(a.lastVerifiedAt));
  const live = items.filter((i) => i.kind === 'live').sort((a, b) => (a.watchId ?? '').localeCompare(b.watchId ?? '') || (a.position ?? 99) - (b.position ?? 99));
  return [...live, ...noted, ...curated];
}

/** Adds a hand-curated reference (owner). */
export async function createTrend(input: z.infer<typeof CreateTrendSchema>): Promise<TrendItemDto> {
  const inserted = await getDb()
    .insert(schema.trendReferences)
    .values({ id: newId(), ...input, sourceKind: 'curated', lastVerifiedAt: new Date(), data: { sources: [] } })
    .returning();
  const row = inserted[0];
  if (!row) throw new AppError('INTERNAL', 'The reference could not be saved.');
  return toTrendItemDto(row, null);
}

/** Updates fields, the enabled flag or the review date of a curated reference (owner). */
export async function updateTrend(input: z.infer<typeof UpdateTrendSchema>): Promise<TrendItemDto> {
  const { id, markVerified, ...fields } = input;
  const set: Partial<typeof schema.trendReferences.$inferInsert> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  // A source the owner edits replaces the collected source list, so the link shown is the one they typed.
  if (fields.sourceName !== undefined || fields.sourceUrl !== undefined) set.data = { sources: [] };
  if (markVerified) set.lastVerifiedAt = new Date();
  const r = schema.trendReferences;
  const updated = await getDb().update(r).set(set).where(and(eq(r.id, id), eq(r.sourceKind, 'curated'))).returning();
  const row = updated[0];
  if (!row) throw new AppError('NOT_FOUND', 'That reference could not be found.');
  return toTrendItemDto(row, null);
}

/** Deletes a curated reference permanently (owner). Live and noted items have their own routes. */
export async function deleteTrend(id: string): Promise<void> {
  const r = schema.trendReferences;
  const deleted = await getDb().delete(r).where(and(eq(r.id, id), eq(r.sourceKind, 'curated'))).returning({ id: r.id });
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'That reference could not be found.');
}

/** "Note a trend": anyone signed in may record something they saw themselves. */
export async function noteTrend(user: SessionUser, input: z.infer<typeof NoteTrendSchema>): Promise<TrendItemDto> {
  const now = new Date();
  const inserted = await getDb()
    .insert(schema.trendReferences)
    .values({
      id: newId(),
      title: input.title,
      summary: input.summary,
      category: input.category,
      sourceName: 'Noted by staff',
      sourceUrl: input.sourceUrl,
      sourceKind: 'noted',
      lastVerifiedAt: now,
      enabled: true,
      data: NotedTrendDataSchema.parse({ platform: input.platform, seenOn: input.seenOn }),
      notedBy: user.id,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new AppError('INTERNAL', 'The note could not be saved.');
  await writeAudit({ userId: user.id, action: 'trends.noted', entityType: 'trend_reference', entityId: row.id, data: { platform: input.platform, category: input.category } });
  return toTrendItemDto(row, user.displayName, now);
}

/** Deletes a noted trend: the owner may delete any, others only their own. */
export async function deleteNotedTrend(user: SessionUser, id: string): Promise<void> {
  const r = schema.trendReferences;
  const db = getDb();
  const row = await db.query.trendReferences.findFirst({ where: and(eq(r.id, id), eq(r.sourceKind, 'noted')) });
  if (!row) throw new AppError('NOT_FOUND', 'That note could not be found.');
  if (user.role !== 'owner' && row.notedBy !== user.id) throw new AppError('FORBIDDEN', 'Only the owner or the person who noted it can delete this.');
  await db.delete(r).where(and(eq(r.id, id), eq(r.sourceKind, 'noted')));
  await writeAudit({ userId: user.id, action: 'trends.note_deleted', entityType: 'trend_reference', entityId: id });
}
