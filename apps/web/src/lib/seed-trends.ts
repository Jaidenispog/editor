import 'server-only';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { newId, type TrendCategory } from '@studio/core';
import { schema } from '@studio/db';
import { getDb } from './db.js';

/**
 * Curated barber content formats (Settings → Trends → Curated references). Format descriptions only: no statistics,
 * no song names, nothing presented as live data, and never worded as "trending now" (research memo §11).
 *
 * History: the first seed (marker `trends.seeded_curated`) had eight formats with no sources. Version 2 (marker
 * `trends.curated_sources_v2`) re-sources them to the memo's URLs, marks the formats the memo found no source for
 * as editor suggestions, and adds the memo's other sourced formats. It only touches rows that still carry the
 * original seed source name and title, so references the owner edited are left alone.
 */

/** Source name of the first seed; rows still carrying it are the only ones version 2 updates. */
export const ORIGINAL_SEED_SOURCE_NAME = 'Studio Assistant curated reference';
const SEED_MARKER_ACTION = 'trends.seeded_curated';
const SOURCES_V2_MARKER_ACTION = 'trends.curated_sources_v2';

/** When the memo's sources were reviewed (docs/research/platform-constraints.md, verified 9 Nov 2026). */
export const CURATED_REVIEWED_AT = new Date('2026-11-09T01:00:00.000Z');

/**
 * The memo's sources for the barber formats (§11): marketing and community blogs whose performance claims are
 * unverified. The memo lists them for the group of formats as a whole, so each sourced format links to all four.
 */
export const CURATED_SOURCES = [
  { name: 'Cadmen Academy — barbershop TikTok content ideas', url: 'https://academy.cadmen.ca/post/barbershop-tiktok-content-ideas' },
  { name: 'FlowShorts — Instagram Reels ideas for hair salons', url: 'https://flowshorts.app/instagram-reels-ideas/hair-salon' },
  { name: 'Dingg — what salons need to post on TikTok and Instagram Reels', url: 'https://dingg.app/blogs/what-us-salons-need-to-post-on-tiktok-and-instagram-reels-checklist' },
  { name: 'YouTube — barber content ideas video', url: 'https://www.youtube.com/watch?v=aQHtTLYf25c' },
] as const;

/** Source name shown for the sourced formats. */
export const CURATED_SOURCE_NAME = 'Barber and salon marketing guides, 2026 (their claims are unverified)';
/** Source name of the formats the memo found no source for. */
export const EDITOR_SUGGESTION_SOURCE_NAME = 'Editor suggestion';

/** One curated format as seeded. `sourced: false` → "Editor suggestion — no external source". */
export interface CuratedFormat {
  title: string;
  summary: string;
  category: TrendCategory;
  sourced: boolean;
}

/** The first seed's formats, exactly as they were inserted (used to recognise untouched rows). */
export const CURATED_TRENDS_V1: Array<{ title: string; summary: string; category: TrendCategory }> = [
  { title: 'Before/after reveal', summary: 'Open on the client as they walked in, hold for a beat, then cut hard to the finished cut. The contrast is the hook, so keep the before shot honest and well lit.', category: 'format' },
  { title: 'Fade detail close-up', summary: 'Slow, steady close-ups of the fade and blend line. Works best with soft light from the side so the gradient reads clearly on a phone screen.', category: 'format' },
  { title: 'Satisfying line-up', summary: 'Tight shots of the trimmer or razor shaping the hairline and beard edges. Let the original sound carry it when the clippers are clean and audible.', category: 'hook' },
  { title: 'Transformation with reaction', summary: 'Build through the process, then finish on the client seeing the result in the mirror. Only use a reaction that genuinely happened on camera.', category: 'format' },
  { title: 'POV chair', summary: 'Filmed from the client’s point of view in the chair, so viewers feel like they are getting the cut. Keep the camera steady and the framing close.', category: 'format' },
  { title: 'Speed-ramp montage', summary: 'Speed up the repetitive parts of the cut and slow down for key moments such as the final fade pass and the reveal, timed to the music.', category: 'pacing' },
  { title: 'Client story', summary: 'A short spoken line from the client or barber (why they came in, what they asked for) over the cut. Captions should use their actual words only.', category: 'text_style' },
  { title: 'Shop atmosphere', summary: 'Wide and medium shots of the studio, tools and people at work to show what it feels like to visit. A good closing shot for promotional edits.', category: 'format' },
];

/** The current curated list (version 2), in display order. */
export const CURATED_TRENDS: CuratedFormat[] = [
  { title: 'Before/after reveal with commentary', summary: 'Open on the client as they walked in, then cut to the finished look while the barber says what was done. Keep the before shot honest and well lit.', category: 'format', sourced: true },
  { title: 'Fade process, no voiceover', summary: 'Slow, steady close-ups of the fade with only the clippers’ own sound (often called ASMR). Soft side light helps the blend line read on a phone screen.', category: 'format', sourced: true },
  { title: 'Line-up and 360° finish', summary: 'Tight shots of the trimmer or razor shaping the hairline, then a slow walk around the finished cut. Let the original sound carry it when the clippers are clean and audible.', category: 'hook', sourced: true },
  { title: 'Transformation with client reaction', summary: 'Build through the process and finish on the client seeing the result. Only use a reaction that genuinely happened on camera, and ask the client’s permission before posting.', category: 'format', sourced: true },
  { title: 'Technique explainer', summary: 'The barber explains one technique while doing it, such as how a skin fade is blended. Captions use only the words actually spoken.', category: 'text_style', sourced: true },
  { title: 'Fast cut montage', summary: 'Quick cuts through the whole service, from the first pass to the finished look, timed to a track you hold a licence for.', category: 'pacing', sourced: true },
  { title: 'Timelapse, posted to both apps', summary: 'A sped-up timelapse of the whole cut, posted on Instagram and TikTok. Use music licensed for both, or add a sound inside each app when you post.', category: 'pacing', sourced: true },
  { title: 'POV chair', summary: CURATED_TRENDS_V1[4]!.summary, category: 'format', sourced: false },
  { title: 'Speed-ramp montage', summary: CURATED_TRENDS_V1[5]!.summary, category: 'pacing', sourced: false },
  { title: 'Client story', summary: CURATED_TRENDS_V1[6]!.summary, category: 'text_style', sourced: false },
  { title: 'Shop atmosphere', summary: CURATED_TRENDS_V1[7]!.summary, category: 'format', sourced: false },
];

/** Which version 2 format each first-seed format became (by title). */
const V1_TO_V2: Record<string, string> = {
  'Before/after reveal': 'Before/after reveal with commentary',
  'Fade detail close-up': 'Fade process, no voiceover',
  'Satisfying line-up': 'Line-up and 360° finish',
  'Transformation with reaction': 'Transformation with client reaction',
  'POV chair': 'POV chair',
  'Speed-ramp montage': 'Speed-ramp montage',
  'Client story': 'Client story',
  'Shop atmosphere': 'Shop atmosphere',
};

/** The stored source fields of a format. */
function sourceFields(f: CuratedFormat) {
  return f.sourced
    ? { sourceName: CURATED_SOURCE_NAME, sourceUrl: CURATED_SOURCES[0].url, data: { sources: CURATED_SOURCES.map((s) => ({ name: s.name, url: s.url })) } }
    : { sourceName: EDITOR_SUGGESTION_SOURCE_NAME, sourceUrl: '', data: { sources: [] } };
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

async function hasMarker(tx: Tx, action: string): Promise<boolean> {
  const rows = await tx.select({ id: schema.auditLog.id }).from(schema.auditLog).where(eq(schema.auditLog.action, action)).limit(1);
  return rows.length > 0;
}

async function writeMarker(tx: Tx, action: string, data: Record<string, unknown>): Promise<void> {
  await tx.insert(schema.auditLog).values({ id: newId(), userId: null, action, entityType: 'trend_references', data });
}

function rowFor(f: CuratedFormat) {
  return { id: newId(), title: f.title, summary: f.summary, category: f.category, sourceKind: 'curated' as const, lastVerifiedAt: CURATED_REVIEWED_AT, enabled: true, ...sourceFields(f) };
}

/**
 * Seeds the curated formats the first time the app runs with an empty table, then applies the version 2 sources
 * once. Markers in the audit log make each step happen once ever (deleting references does not bring them back),
 * and a transaction-scoped advisory lock keeps two processes from doing it twice. Returns the rows inserted or
 * updated.
 */
export async function ensureCuratedTrends(): Promise<{ inserted: number; updated: number }> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('studio:trends:curated_seed'))`);
    let inserted = 0;
    let updated = 0;
    const r = schema.trendReferences;
    if (!(await hasMarker(tx, SEED_MARKER_ACTION))) {
      const existing = await tx.select({ n: count() }).from(r);
      if (Number(existing[0]?.n ?? 0) === 0) {
        await tx.insert(r).values(CURATED_TRENDS.map(rowFor));
        inserted = CURATED_TRENDS.length;
        await writeMarker(tx, SEED_MARKER_ACTION, { inserted, version: 2 });
        await writeMarker(tx, SOURCES_V2_MARKER_ACTION, { updated: 0, inserted: 0, freshInstall: true });
        return { inserted, updated };
      }
      await writeMarker(tx, SEED_MARKER_ACTION, { inserted: 0 });
    }
    if (await hasMarker(tx, SOURCES_V2_MARKER_ACTION)) return { inserted, updated };

    const v2ByTitle = new Map(CURATED_TRENDS.map((f) => [f.title, f]));
    const seedRows = await tx
      .select()
      .from(r)
      .where(and(eq(r.sourceKind, 'curated'), eq(r.sourceName, ORIGINAL_SEED_SOURCE_NAME), inArray(r.title, CURATED_TRENDS_V1.map((v) => v.title))));
    for (const row of seedRows) {
      const v1 = CURATED_TRENDS_V1.find((v) => v.title === row.title);
      const v2 = v1 ? v2ByTitle.get(V1_TO_V2[v1.title] ?? '') : undefined;
      if (!v1 || !v2) continue;
      // The wording is replaced only when the owner had not changed it; the sources always are.
      const untouched = row.summary === v1.summary && row.category === v1.category;
      await tx
        .update(r)
        .set({ ...sourceFields(v2), ...(untouched ? { title: v2.title, summary: v2.summary, category: v2.category } : {}), lastVerifiedAt: CURATED_REVIEWED_AT, updatedAt: new Date() })
        .where(and(eq(r.id, row.id), eq(r.sourceName, ORIGINAL_SEED_SOURCE_NAME)));
      updated++;
    }
    const titles = new Set((await tx.select({ title: r.title }).from(r).where(eq(r.sourceKind, 'curated'))).map((x) => x.title));
    const mapped = new Set(Object.values(V1_TO_V2));
    const added = CURATED_TRENDS.filter((f) => !mapped.has(f.title) && !titles.has(f.title));
    if (added.length) await tx.insert(r).values(added.map(rowFor));
    inserted += added.length;
    await writeMarker(tx, SOURCES_V2_MARKER_ACTION, { updated, inserted: added.length });
    return { inserted, updated };
  });
}
