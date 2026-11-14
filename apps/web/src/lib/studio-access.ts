import 'server-only';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { AppError } from '@studio/core';
import { schema, type Edit, type EditVersion, type JobRow, type MediaAsset, type Project } from '@studio/db';
import type { SessionUser } from './auth.js';
import { getDb } from './db.js';

/**
 * Whether the signed-in user may work on a project: the studio owner can open every project, staff only the
 * projects they created.
 */
export function canAccessProject(project: Pick<Project, 'ownerId' | 'deletedAt'>, user: Pick<SessionUser, 'id' | 'role'>): boolean {
  if (project.deletedAt) return false;
  return user.role === 'owner' || project.ownerId === user.id;
}

/**
 * SQL condition limiting a projects query to the ones the user may see: none for the owner (every project),
 * `projects.owner_id = user` for staff. Combine it with the query's other filters.
 */
export function projectVisibilityFilter(user: Pick<SessionUser, 'id' | 'role'>): SQL | undefined {
  return user.role === 'owner' ? undefined : eq(schema.projects.ownerId, user.id);
}

/** Loads a non-deleted project the user may work on, or throws NOT_FOUND (never reveals other projects). */
export async function getAccessibleProject(projectId: string, user: SessionUser): Promise<Project> {
  const project = await getDb().query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)) });
  if (!project || !canAccessProject(project, user)) throw new AppError('NOT_FOUND', 'That project could not be found. It may have been deleted.');
  return project;
}

/** Loads a clip (and its project) the user may work on, or throws NOT_FOUND. */
export async function getAccessibleAsset(assetId: string, user: SessionUser): Promise<{ asset: MediaAsset; project: Project }> {
  const asset = await getDb().query.mediaAssets.findFirst({ where: and(eq(schema.mediaAssets.id, assetId), isNull(schema.mediaAssets.deletedAt)) });
  if (!asset) throw new AppError('NOT_FOUND', 'That clip could not be found. It may have been removed.');
  const project = await getAccessibleProject(asset.projectId, user).catch(() => {
    throw new AppError('NOT_FOUND', 'That clip could not be found. It may have been removed.');
  });
  return { asset, project };
}

/** Loads an edit (and its project) the user may work on, or throws NOT_FOUND. */
export async function getAccessibleEdit(editId: string, user: SessionUser): Promise<{ edit: Edit; project: Project }> {
  const edit = await getDb().query.edits.findFirst({ where: and(eq(schema.edits.id, editId), isNull(schema.edits.deletedAt)) });
  if (!edit) throw new AppError('NOT_FOUND', 'That edit could not be found.');
  const project = await getAccessibleProject(edit.projectId, user).catch(() => {
    throw new AppError('NOT_FOUND', 'That edit could not be found.');
  });
  return { edit, project };
}

/** Loads an edit version (with its edit and project) the user may work on, or throws NOT_FOUND. */
export async function getAccessibleVersion(versionId: string, user: SessionUser): Promise<{ version: EditVersion; edit: Edit; project: Project }> {
  const version = await getDb().query.editVersions.findFirst({ where: eq(schema.editVersions.id, versionId) });
  if (!version) throw new AppError('NOT_FOUND', 'That version could not be found.');
  const { edit, project } = await getAccessibleEdit(version.editId, user).catch(() => {
    throw new AppError('NOT_FOUND', 'That version could not be found.');
  });
  return { version, edit, project };
}

/**
 * Loads a background job the user may act on (cancel, retry), or throws NOT_FOUND. Jobs of a project follow
 * the project's rule; jobs without a project (library music analysis, maintenance) are the owner's.
 */
export async function getAccessibleJob(jobId: string, user: SessionUser): Promise<JobRow> {
  const job = await getDb().query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  const notFound = () => new AppError('NOT_FOUND', 'That job no longer exists.');
  if (!job) throw notFound();
  if (job.projectId) {
    await getAccessibleProject(job.projectId, user).catch(() => {
      throw notFound();
    });
  } else if (user.role !== 'owner') {
    throw notFound();
  }
  return job;
}
