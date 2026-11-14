import 'server-only';
import { count, eq } from 'drizzle-orm';
import { newId } from '@studio/core';
import { schema } from '@studio/db';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';

const SOURCE_NAME = 'Studio Assistant curated reference';
const SEED_MARKER_ACTION = 'trends.seeded_curated';

/** Format descriptions only: no statistics, no song names, nothing presented as live trend data. */
export const CURATED_TRENDS: Array<{ title: string; summary: string; category: 'format' | 'hook' | 'pacing' | 'text_style' }> = [
  {
    title: 'Before/after reveal',
    summary: 'Open on the client as they walked in, hold for a beat, then cut hard to the finished cut. The contrast is the hook, so keep the before shot honest and well lit.',
    category: 'format',
  },
  {
    title: 'Fade detail close-up',
    summary: 'Slow, steady close-ups of the fade and blend line. Works best with soft light from the side so the gradient reads clearly on a phone screen.',
    category: 'format',
  },
  {
    title: 'Satisfying line-up',
    summary: 'Tight shots of the trimmer or razor shaping the hairline and beard edges. Let the original sound carry it when the clippers are clean and audible.',
    category: 'hook',
  },
  {
    title: 'Transformation with reaction',
    summary: 'Build through the process, then finish on the client seeing the result in the mirror. Only use a reaction that genuinely happened on camera.',
    category: 'format',
  },
  {
    title: 'POV chair',
    summary: 'Filmed from the client’s point of view in the chair, so viewers feel like they are getting the cut. Keep the camera steady and the framing close.',
    category: 'format',
  },
  {
    title: 'Speed-ramp montage',
    summary: 'Speed up the repetitive parts of the cut and slow down for key moments such as the final fade pass and the reveal, timed to the music.',
    category: 'pacing',
  },
  {
    title: 'Client story',
    summary: 'A short spoken line from the client or barber (why they came in, what they asked for) over the cut. Captions should use their actual words only.',
    category: 'text_style',
  },
  {
    title: 'Shop atmosphere',
    summary: 'Wide and medium shots of the studio, tools and people at work to show what it feels like to visit. A good closing shot for promotional edits.',
    category: 'format',
  },
];

/**
 * Inserts the curated barber content references the first time the app runs with an empty table.
 * A marker in the audit log makes this happen once ever, so deleting them later does not bring them back.
 */
export async function ensureCuratedTrends(): Promise<number> {
  const db = getDb();
  const marker = await db.query.auditLog.findFirst({ where: eq(schema.auditLog.action, SEED_MARKER_ACTION) });
  if (marker) return 0;
  const existing = await db.select({ n: count() }).from(schema.trendReferences);
  if (Number(existing[0]?.n ?? 0) === 0) {
    const now = new Date();
    await db.insert(schema.trendReferences).values(
      CURATED_TRENDS.map((t) => ({
        id: newId(),
        title: t.title,
        summary: t.summary,
        category: t.category,
        sourceName: SOURCE_NAME,
        sourceUrl: '',
        sourceKind: 'curated' as const,
        lastVerifiedAt: now,
        enabled: true,
      })),
    );
  }
  await writeAudit({ userId: null, action: SEED_MARKER_ACTION, entityType: 'trend_references', data: { inserted: Number(existing[0]?.n ?? 0) === 0 ? CURATED_TRENDS.length : 0 } });
  return Number(existing[0]?.n ?? 0) === 0 ? CURATED_TRENDS.length : 0;
}
