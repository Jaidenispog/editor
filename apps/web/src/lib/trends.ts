import 'server-only';
import { asc, desc, eq } from 'drizzle-orm';
import { AppError, newId } from '@studio/core';
import { schema } from '@studio/db';
import { z } from 'zod';
import { getDb } from './db.js';

const TREND_CATEGORIES = ['format', 'sound', 'hook', 'text_style', 'pacing', 'other'] as const;

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || /^https?:\/\//i.test(v), 'Links must start with http:// or https://');

/** Body for POST /api/trends. References added by hand are always "curated". */
export const CreateTrendSchema = z.object({
  title: z.string().trim().min(1, 'Add a title').max(160),
  summary: z.string().trim().max(2000).default(''),
  category: z.enum(TREND_CATEGORIES).default('format'),
  sourceName: z.string().trim().min(1, 'Say where this reference comes from').max(160),
  sourceUrl: httpUrl.default(''),
  enabled: z.boolean().default(true),
});

/** Body for PUT /api/trends: id plus any fields to change (including the enabled flag). */
export const UpdateTrendSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(160).optional(),
  summary: z.string().trim().max(2000).optional(),
  category: z.enum(TREND_CATEGORIES).optional(),
  sourceName: z.string().trim().min(1).max(160).optional(),
  sourceUrl: httpUrl.optional(),
  enabled: z.boolean().optional(),
  /** Marks the reference as checked again today. */
  markVerified: z.boolean().optional(),
});

/** Trend reference as sent to the browser. */
export interface TrendSummary {
  id: string;
  title: string;
  summary: string;
  category: (typeof TREND_CATEGORIES)[number];
  sourceName: string;
  sourceUrl: string;
  sourceKind: 'curated' | 'live';
  lastVerifiedAt: string;
  enabled: boolean;
}

function toSummary(r: typeof schema.trendReferences.$inferSelect): TrendSummary {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    category: r.category,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    sourceKind: r.sourceKind,
    lastVerifiedAt: r.lastVerifiedAt.toISOString(),
    enabled: r.enabled,
  };
}

/** All trend references, enabled first then newest. */
export async function listTrends(): Promise<TrendSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.trendReferences)
    .orderBy(desc(schema.trendReferences.enabled), asc(schema.trendReferences.title));
  return rows.map(toSummary);
}

/** Adds a hand-curated reference. */
export async function createTrend(input: z.infer<typeof CreateTrendSchema>): Promise<TrendSummary> {
  const inserted = await getDb()
    .insert(schema.trendReferences)
    .values({ id: newId(), ...input, sourceKind: 'curated', lastVerifiedAt: new Date() })
    .returning();
  const row = inserted[0];
  if (!row) throw new AppError('INTERNAL', 'The reference could not be saved.');
  return toSummary(row);
}

/** Updates fields or the enabled flag of a reference. */
export async function updateTrend(input: z.infer<typeof UpdateTrendSchema>): Promise<TrendSummary> {
  const { id, markVerified, ...fields } = input;
  const set: Partial<typeof schema.trendReferences.$inferInsert> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  if (markVerified) set.lastVerifiedAt = new Date();
  const updated = await getDb().update(schema.trendReferences).set(set).where(eq(schema.trendReferences.id, id)).returning();
  const row = updated[0];
  if (!row) throw new AppError('NOT_FOUND', 'That reference could not be found.');
  return toSummary(row);
}

/** Deletes a reference permanently. */
export async function deleteTrend(id: string): Promise<void> {
  const deleted = await getDb().delete(schema.trendReferences).where(eq(schema.trendReferences.id, id)).returning({ id: schema.trendReferences.id });
  if (deleted.length === 0) throw new AppError('NOT_FOUND', 'That reference could not be found.');
}
