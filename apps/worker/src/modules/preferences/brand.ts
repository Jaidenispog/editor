import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { RenderBrandSnapshotSchema, brandSnapshotFrom, type AppSettings, type RenderBrandSnapshot } from '@studio/core';
import { schema } from '@studio/db';
import { ffprobeRaw, type RenderBrand } from '@studio/media';
import type { WorkerContext } from '../../context.js';

/** Shown on the version when the logo file could not be found. */
export const LOGO_MISSING_NOTE = 'Logo not found — rendered without it';

/** Where a logo used by a render is kept, by content hash, so an export can use the exact logo its preview used. */
export function renderLogoKey(sha256: string, ext: string): string {
  return `brand/render-logos/${sha256}.${ext}`;
}
const RENDER_LOGO_PREFIX = 'brand/render-logos/';

/** The brand the renderer draws with, the snapshot to keep on the version, and an optional note for the owner. */
export interface PreparedBrand {
  brand: RenderBrand;
  snapshot: RenderBrandSnapshot;
  note: string | null;
}

async function logoSize(ctx: WorkerContext, file: string): Promise<{ width: number; height: number } | null> {
  try {
    const raw = await ffprobeRaw(file, ctx.env.FFPROBE_PATH);
    const stream = raw.streams.find((s) => s.codec_type === 'video');
    return stream?.width && stream.height ? { width: stream.width, height: stream.height } : null;
  } catch {
    return null;
  }
}

function toRenderBrand(snapshot: RenderBrandSnapshot, logo: RenderBrand['logo']): RenderBrand {
  return {
    accentColour: snapshot.accentColour,
    videoTextStyle: snapshot.videoTextStyle,
    fontHeadline: snapshot.fontHeadline,
    fontBody: snapshot.fontBody,
    socialHandle: snapshot.socialHandle,
    logo,
  };
}

/** Downloads a logo into the job's temp dir; null when the file is gone. */
async function fetchLogo(ctx: WorkerContext, key: string, tmp: string): Promise<{ file: string; ext: string } | null> {
  const ext = key.split('.').pop() ?? 'png';
  const file = path.join(tmp, `logo.${ext}`);
  try {
    await ctx.store.downloadToFile(key, file);
    return { file, ext };
  } catch (err) {
    ctx.logger.warn({ err, key }, 'logo file missing; rendering without it');
    return null;
  }
}

/**
 * The brand for a preview: current Settings → Branding, with the logo copied to a content-addressed key so the
 * version's export can use the very same file later even if the owner uploads a new logo in between.
 */
export async function brandForPreview(ctx: WorkerContext, settings: AppSettings, tmp: string): Promise<PreparedBrand> {
  const b = settings.brand;
  if (b.logoPlacement === 'off' || !b.logoStorageKey) return { brand: toRenderBrand(brandSnapshotFrom(b, null), null), snapshot: brandSnapshotFrom(b, null), note: null };
  const fetched = await fetchLogo(ctx, b.logoStorageKey, tmp);
  const size = fetched ? await logoSize(ctx, fetched.file) : null;
  if (!fetched || !size) {
    const snapshot = brandSnapshotFrom(b, null);
    return { brand: toRenderBrand(snapshot, null), snapshot, note: LOGO_MISSING_NOTE };
  }
  const sha = createHash('sha256').update(await readFile(fetched.file)).digest('hex');
  const copyKey = renderLogoKey(sha, fetched.ext);
  if (!(await ctx.store.exists(copyKey))) await ctx.store.putFile(copyKey, fetched.file, { contentType: fetched.ext === 'png' ? 'image/png' : fetched.ext === 'webp' ? 'image/webp' : 'image/jpeg' });
  const snapshot = brandSnapshotFrom({ ...b, logoStorageKey: copyKey }, sha);
  const logo = snapshot.logo ? { path: fetched.file, ...size, placement: snapshot.logo.placement, corner: snapshot.logo.corner, opacity: snapshot.logo.opacity } : null;
  return { brand: toRenderBrand(snapshot, logo), snapshot, note: null };
}

/**
 * The brand for an export: the snapshot its preview was rendered with, so the export matches the preview. Versions
 * rendered before snapshots existed fall back to the current settings.
 */
export async function brandForExport(ctx: WorkerContext, stored: unknown, settings: AppSettings, tmp: string): Promise<PreparedBrand> {
  const parsed = RenderBrandSnapshotSchema.safeParse(stored);
  if (!parsed.success) return brandForPreview(ctx, settings, tmp);
  const snapshot = parsed.data;
  if (!snapshot.logo) return { brand: toRenderBrand(snapshot, null), snapshot, note: null };
  const fetched = await fetchLogo(ctx, snapshot.logo.storageKey, tmp);
  const size = fetched ? await logoSize(ctx, fetched.file) : null;
  if (!fetched || !size) return { brand: toRenderBrand(snapshot, null), snapshot, note: LOGO_MISSING_NOTE };
  const logo = { path: fetched.file, ...size, placement: snapshot.logo.placement, corner: snapshot.logo.corner, opacity: snapshot.logo.opacity };
  return { brand: toRenderBrand(snapshot, logo), snapshot, note: null };
}

/**
 * Cleanup: deletes logo copies that no version refers to and that are more than a day old. Logos are small; this
 * keeps storage tidy after the owner replaces a logo and old versions are deleted.
 */
export async function cleanupRenderLogos(ctx: WorkerContext): Promise<string> {
  const keys = await ctx.store.list(RENDER_LOGO_PREFIX);
  if (keys.length === 0) return 'no logo copies';
  const rows = await ctx.db
    .selectDistinct({ key: sql<string | null>`${schema.editVersions.renderBrand} #>> '{logo,storageKey}'` })
    .from(schema.editVersions)
    .where(sql`${schema.editVersions.renderBrand} #>> '{logo,storageKey}' is not null`);
  const used = new Set(rows.map((r) => r.key).filter((k): k is string => Boolean(k)));
  let removed = 0;
  const dayAgo = Date.now() - 86_400_000;
  for (const key of keys) {
    if (used.has(key)) continue;
    try {
      // A copy made by a preview that is still rendering is not referenced yet: keep anything younger than a day.
      const info = await ctx.store.stat(key);
      if (!info || !info.lastModified || info.lastModified.getTime() > dayAgo) continue;
      await ctx.store.delete(key);
      removed++;
    } catch (err) {
      ctx.logger.warn({ err, key }, 'could not delete an unused logo copy');
    }
  }
  return `removed ${removed} unused logo cop${removed === 1 ? 'y' : 'ies'}`;
}
