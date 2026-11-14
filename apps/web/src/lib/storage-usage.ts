import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema } from '@studio/db';
import { getDb } from './db.js';

/** Bytes stored per project and overall, computed from recorded file sizes (originals, exports and music). */
export interface StorageUsage {
  totalBytes: number;
  originalsBytes: number;
  exportsBytes: number;
  musicBytes: number;
  projects: Array<{ id: string; title: string; originalsBytes: number; exportsBytes: number; clipCount: number }>;
}

/**
 * Storage used, from the sizes recorded in the database. Proxies, thumbnails and previews are not sized in the
 * database and add roughly 10–20% on top; the page says so.
 */
export async function getStorageUsage(): Promise<StorageUsage> {
  const db = getDb();
  const [assets, exportsRows, music] = await Promise.all([
    db
      .select({
        id: schema.projects.id,
        title: schema.projects.title,
        bytes: sql<string>`coalesce(sum(${schema.mediaAssets.byteSize}), 0)`,
        clips: sql<string>`count(${schema.mediaAssets.id})`,
      })
      .from(schema.projects)
      .leftJoin(schema.mediaAssets, and(eq(schema.mediaAssets.projectId, schema.projects.id), isNull(schema.mediaAssets.deletedAt)))
      .where(isNull(schema.projects.deletedAt))
      .groupBy(schema.projects.id, schema.projects.title)
      .orderBy(desc(sql`coalesce(sum(${schema.mediaAssets.byteSize}), 0)`)),
    db
      .select({ projectId: schema.edits.projectId, bytes: sql<string>`coalesce(sum(${schema.editVersions.exportByteSize}), 0)` })
      .from(schema.editVersions)
      .innerJoin(schema.edits, eq(schema.editVersions.editId, schema.edits.id))
      .groupBy(schema.edits.projectId),
    db.select({ bytes: sql<string>`coalesce(sum(${schema.musicTracks.byteSize}), 0)` }).from(schema.musicTracks).where(isNull(schema.musicTracks.deletedAt)),
  ]);
  const exportsBy = new Map(exportsRows.map((e) => [e.projectId, Number(e.bytes)]));
  const projects = assets.map((a) => ({ id: a.id, title: a.title, originalsBytes: Number(a.bytes), exportsBytes: exportsBy.get(a.id) ?? 0, clipCount: Number(a.clips) }));
  const originalsBytes = projects.reduce((s, p) => s + p.originalsBytes, 0);
  const exportsBytes = projects.reduce((s, p) => s + p.exportsBytes, 0);
  const musicBytes = Number(music[0]?.bytes ?? 0);
  return { totalBytes: originalsBytes + exportsBytes + musicBytes, originalsBytes, exportsBytes, musicBytes, projects };
}
