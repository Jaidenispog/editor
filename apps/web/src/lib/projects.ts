import 'server-only';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppError, newId } from '@studio/core';
import { schema, type Project } from '@studio/db';
import { storageKeys } from '@studio/storage';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { cancelProjectJobs } from './jobs.js';
import { getLogger } from './logger.js';
import { getBlobStore } from './storage.js';

/** Body for POST /api/projects. */
export const CreateProjectSchema = z.object({
  title: z.string().trim().min(1, 'Give the project a name').max(120),
  clientName: z.string().trim().max(120).optional().default(''),
  notes: z.string().trim().max(2000).optional().default(''),
});

/** Body for PATCH /api/projects/[id]. */
export const UpdateProjectSchema = z
  .object({
    title: z.string().trim().min(1, 'Give the project a name').max(120),
    clientName: z.string().trim().max(120),
    notes: z.string().trim().max(2000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** A project row as sent to the browser, with counts for the list view. */
export interface ProjectSummary {
  id: string;
  title: string;
  clientName: string;
  notes: string;
  status: Project['status'];
  createdAt: string;
  updatedAt: string;
  assetCount: number;
  readyAssetCount: number;
  editCount: number;
  latestGeneration: { id: string; status: string; statusMessage: string; createdAt: string } | null;
}

function toIso(d: Date): string {
  return d.toISOString();
}

/** Lists projects that have not been deleted, newest activity first, with asset counts and latest generation. */
export async function listProjects(options: { limit?: number; search?: string } = {}): Promise<ProjectSummary[]> {
  const db = getDb();
  const filters = [isNull(schema.projects.deletedAt)];
  if (options.search?.trim()) {
    const term = `%${options.search.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    filters.push(sql`(${schema.projects.title} ilike ${term} or ${schema.projects.clientName} ilike ${term})`);
  }
  const rows = await db
    .select()
    .from(schema.projects)
    .where(and(...filters))
    .orderBy(desc(schema.projects.updatedAt))
    .limit(options.limit ?? 200);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [assetCounts, editCounts, generations] = await Promise.all([
    db
      .select({
        projectId: schema.mediaAssets.projectId,
        total: count(),
        ready: sql<number>`count(*) filter (where ${schema.mediaAssets.status} = 'ready')`,
      })
      .from(schema.mediaAssets)
      .where(and(inArray(schema.mediaAssets.projectId, ids), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.kind, 'video')))
      .groupBy(schema.mediaAssets.projectId),
    db
      .select({ projectId: schema.edits.projectId, total: count() })
      .from(schema.edits)
      .where(and(inArray(schema.edits.projectId, ids), isNull(schema.edits.deletedAt)))
      .groupBy(schema.edits.projectId),
    db
      .selectDistinctOn([schema.generations.projectId], {
        projectId: schema.generations.projectId,
        id: schema.generations.id,
        status: schema.generations.status,
        statusMessage: schema.generations.statusMessage,
        createdAt: schema.generations.createdAt,
      })
      .from(schema.generations)
      .where(inArray(schema.generations.projectId, ids))
      .orderBy(schema.generations.projectId, desc(schema.generations.createdAt)),
  ]);
  const assetsBy = new Map(assetCounts.map((a) => [a.projectId, a]));
  const editsBy = new Map(editCounts.map((e) => [e.projectId, Number(e.total)]));
  const genBy = new Map(generations.map((g) => [g.projectId, g]));
  return rows.map((p) => {
    const a = assetsBy.get(p.id);
    const g = genBy.get(p.id);
    return {
      id: p.id,
      title: p.title,
      clientName: p.clientName,
      notes: p.notes,
      status: p.status,
      createdAt: toIso(p.createdAt),
      updatedAt: toIso(p.updatedAt),
      assetCount: Number(a?.total ?? 0),
      readyAssetCount: Number(a?.ready ?? 0),
      editCount: editsBy.get(p.id) ?? 0,
      latestGeneration: g ? { id: g.id, status: g.status, statusMessage: g.statusMessage, createdAt: toIso(g.createdAt) } : null,
    };
  });
}

/** Loads a non-deleted project or throws NOT_FOUND. */
export async function getProjectOrThrow(id: string): Promise<Project> {
  const project = await getDb().query.projects.findFirst({ where: and(eq(schema.projects.id, id), isNull(schema.projects.deletedAt)) });
  if (!project) throw new AppError('NOT_FOUND', 'That project could not be found. It may have been deleted.');
  return project;
}

/** Creates an empty project owned by the user. */
export async function createProject(userId: string, input: z.infer<typeof CreateProjectSchema>): Promise<Project> {
  const inserted = await getDb()
    .insert(schema.projects)
    .values({ id: newId(), ownerId: userId, title: input.title, clientName: input.clientName, notes: input.notes, status: 'draft' })
    .returning();
  const project = inserted[0];
  if (!project) throw new AppError('INTERNAL', 'The project could not be created.');
  await writeAudit({ userId, action: 'project.created', entityType: 'project', entityId: project.id });
  return project;
}

/** Updates title, client name or notes. */
export async function updateProject(id: string, input: z.infer<typeof UpdateProjectSchema>): Promise<Project> {
  await getProjectOrThrow(id);
  const updated = await getDb()
    .update(schema.projects)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(schema.projects.id, id))
    .returning();
  const project = updated[0];
  if (!project) throw new AppError('NOT_FOUND', 'That project could not be found.');
  return project;
}

/**
 * Permanently deletes a project: hides it immediately (soft delete), cancels its running jobs, removes every
 * stored file under its storage prefix (and its project-scoped music), then hard-deletes the rows (cascades
 * remove clips, generations, edits, versions and job rows). This cannot be undone.
 */
export async function deleteProjectPermanently(id: string, userId: string): Promise<{ filesRemoved: number }> {
  const db = getDb();
  // Soft-deleted projects are included so a deletion interrupted half-way can be finished.
  const existing = await db.query.projects.findFirst({ columns: { id: true }, where: eq(schema.projects.id, id) });
  if (!existing) throw new AppError('NOT_FOUND', 'That project could not be found. It may already have been deleted.');
  await db.update(schema.projects).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.projects.id, id));
  await cancelProjectJobs(id);
  const store = getBlobStore();
  let filesRemoved = 0;
  try {
    filesRemoved += await store.deletePrefix(storageKeys.projectPrefix(id));
    const tracks = await db.select({ id: schema.musicTracks.id, storageKey: schema.musicTracks.storageKey }).from(schema.musicTracks).where(eq(schema.musicTracks.projectId, id));
    for (const t of tracks) filesRemoved += await store.deletePrefix(storageKeys.musicPrefix(t.id));
  } catch (err) {
    getLogger().error({ err, projectId: id }, 'failed to remove stored files for project');
    throw new AppError('INTERNAL', 'Some files for this project could not be removed. The project is hidden; please try deleting it again.', { cause: err });
  }
  await db.delete(schema.projects).where(eq(schema.projects.id, id));
  await writeAudit({ userId, action: 'project.deleted', entityType: 'project', entityId: id, data: { filesRemoved } });
  return { filesRemoved };
}
