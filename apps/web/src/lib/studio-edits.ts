import 'server-only';
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import { AppError, GenerationSettingsSchema, STYLES, STYLE_IDS, formatSeconds, newId, type GenerationSettings, type StyleId } from '@studio/core';
import { schema, type Edit, type EditVersion, type Generation } from '@studio/db';
import { z } from 'zod';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { ACTIVE_JOB_STATUSES, createTrackedJob } from './jobs.js';
import { downloadNameFor, signedUrlFor } from './media-links.js';
import { getLogger } from './logger.js';
import { getSettings, updateSettings } from './settings.js';
import { getAccessibleEdit, getAccessibleProject, getAccessibleVersion } from './studio-access.js';

/** Generation states that mean a previous press of "Generate" is still being planned. */
const GENERATION_PLANNING = ['queued', 'planning'] as const;

/** Body for POST /api/projects/[id]/generate (styles must be unique). */
export const GenerateRequestSchema = GenerationSettingsSchema.refine((s) => new Set(s.styles).size === s.styles.length, {
  message: 'Each style can only be chosen once',
  path: ['styles'],
});

/** Small allowance for rounding in the browser's slider (the planner snaps the start to a beat anyway). */
const MUSIC_START_SLACK_SEC = 0.05;

/**
 * Checks the owner's music start point against the real track: it must be inside the track and leave enough
 * music for the whole edit. Throws a plain VALIDATION error otherwise.
 */
export function assertMusicStartFits(startSec: number, editSec: number, trackSec: number | null): void {
  const fail = (message: string) => new AppError('VALIDATION', message, { details: [{ path: 'musicStartSec', message }] });
  if (trackSec === null || !(trackSec > 0)) throw fail('The length of that track is not known yet, so the music start cannot be chosen. Leave it on Automatic.');
  if (startSec >= trackSec) throw fail(`The track is only ${formatSeconds(trackSec)} long, so the music cannot start at ${formatSeconds(startSec)}.`);
  const left = trackSec - startSec;
  if (left + MUSIC_START_SLACK_SEC < editSec) {
    throw fail(`Starting the music at ${formatSeconds(startSec)} leaves ${Math.floor(left)} seconds of the track, but the edit is ${editSec} seconds. Choose an earlier start or a shorter length.`);
  }
}

/**
 * Starts a generation: checks the clips are ready and every chosen style is supported, then in one
 * transaction creates the generation, one edit per style (in the fixed style order) and a v1 version in
 * "planning", and finally queues edits.generate. The settings are remembered on the project.
 */
export async function startGeneration(projectId: string, user: SessionUser, raw: z.input<typeof GenerateRequestSchema>): Promise<{ generation: Generation; edits: Edit[]; versions: EditVersion[]; jobId: string }> {
  const settings: GenerationSettings = GenerateRequestSchema.parse(raw);
  const project = await getAccessibleProject(projectId, user);
  const db = getDb();
  const assets = await db.query.mediaAssets.findMany({
    columns: { id: true, status: true },
    where: and(eq(schema.mediaAssets.projectId, project.id), isNull(schema.mediaAssets.deletedAt), eq(schema.mediaAssets.kind, 'video')),
  });
  if (assets.length === 0) throw new AppError('UNSUPPORTED', 'Add your haircut clips before generating edits.');
  if (assets.some((a) => a.status === 'uploaded' || a.status === 'processing')) {
    throw new AppError('CONFLICT', 'Some clips are still being analysed. Generate once they are ready.');
  }
  if (!assets.some((a) => a.status === 'ready')) throw new AppError('UNSUPPORTED', 'None of the clips could be analysed. Retry or replace them first.');

  const support = new Map((project.styleSupport ?? []).map((s) => [s.styleId, s]));
  const unsupported = settings.styles.filter((id) => !support.get(id)?.supported);
  if (unsupported.length) {
    const reasons = unsupported.map((id) => `${STYLES[id].name}: ${support.get(id)?.reason || 'not available for these clips yet.'}`);
    throw new AppError('UNSUPPORTED', `Some chosen styles cannot be made from these clips. ${reasons.join(' ')}`, { details: { styles: unsupported } });
  }

  if (settings.musicTrackId) {
    const track = await db.query.musicTracks.findFirst({
      where: and(eq(schema.musicTracks.id, settings.musicTrackId), isNull(schema.musicTracks.deletedAt), isNull(schema.musicTracks.projectId)),
    });
    if (!track) throw new AppError('VALIDATION', 'That music track is no longer in the library. Choose another one.', { details: [{ path: 'musicTrackId', message: 'Not found' }] });
    if (track.status !== 'ready') throw new AppError('CONFLICT', 'That music track is still being analysed. Wait for it to finish or choose another one.');
    if (!track.licence.confirmedByOwnerAt) throw new AppError('VALIDATION', 'Confirm the licence for that track in Settings → Music before using it.');
    if (settings.musicStartSec !== null) assertMusicStartFits(settings.musicStartSec, settings.durationSec, track.durationSec);
  } else if (settings.musicStartSec !== null) {
    throw new AppError('VALIDATION', 'Choose a music track before picking where the music starts.', { details: [{ path: 'musicStartSec', message: 'No music chosen' }] });
  }

  const busy = await db.query.generations.findFirst({
    columns: { id: true },
    where: and(eq(schema.generations.projectId, project.id), inArray(schema.generations.status, [...GENERATION_PLANNING])),
  });
  if (busy) throw new AppError('CONFLICT', 'Edits are already being planned for this project. Wait for them to finish first.');

  const ordered = STYLE_IDS.filter((id) => settings.styles.includes(id));
  const generationId = newId();
  const created = await db.transaction(async (tx) => {
    const [generation] = await tx
      .insert(schema.generations)
      .values({ id: generationId, projectId: project.id, requestedBy: user.id, settings: { ...settings, styles: ordered }, status: 'queued', statusMessage: 'Waiting to start' })
      .returning();
    const editRows: Edit[] = [];
    const versionRows: EditVersion[] = [];
    for (const [slot, styleId] of ordered.entries()) {
      const editId = newId();
      const versionId = newId();
      const [edit] = await tx.insert(schema.edits).values({ id: editId, projectId: project.id, generationId, styleId, slot, currentVersionId: versionId }).returning();
      const [version] = await tx
        .insert(schema.editVersions)
        .values({ id: versionId, editId, versionNo: 1, origin: 'initial', status: 'planning', statusMessage: 'Waiting to be planned' })
        .returning();
      if (edit) editRows.push(edit);
      if (version) versionRows.push(version);
    }
    await tx.update(schema.projects).set({ lastSettings: { ...settings, styles: ordered }, status: 'generating', updatedAt: new Date() }).where(eq(schema.projects.id, project.id));
    if (!generation) throw new AppError('INTERNAL', 'The generation could not be recorded.');
    return { generation, edits: editRows, versions: versionRows };
  });

  try {
    const job = await createTrackedJob({ type: 'edits.generate', payload: { generationId, projectId: project.id } });
    await writeAudit({ userId: user.id, action: 'generation.started', entityType: 'generation', entityId: generationId, data: { styles: ordered, durationSec: settings.durationSec } });
    return { ...created, jobId: job.id };
  } catch (err) {
    await db.update(schema.generations).set({ status: 'failed', statusMessage: 'Could not start. Please try again.', updatedAt: new Date() }).where(eq(schema.generations.id, generationId));
    await db
      .update(schema.editVersions)
      .set({ status: 'failed', statusMessage: 'Could not start. Please try again.', updatedAt: new Date() })
      .where(inArray(schema.editVersions.id, created.versions.map((v) => v.id)));
    await db.update(schema.projects).set({ status: 'ready', updatedAt: new Date() }).where(eq(schema.projects.id, project.id));
    throw err;
  }
}

/**
 * Marks or unmarks an edit as a favourite. A change also records a feedback event and nudges the style's
 * affinity in the editing preferences (+1 when favourited, −1 when removed, never below zero).
 */
export async function setFavourite(editId: string, user: SessionUser, value: boolean): Promise<{ isFavourite: boolean }> {
  const { edit } = await getAccessibleEdit(editId, user);
  if (edit.isFavourite === value) return { isFavourite: value };
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.update(schema.edits).set({ isFavourite: value, updatedAt: new Date() }).where(eq(schema.edits.id, editId));
    await tx.insert(schema.feedbackEvents).values({
      id: newId(),
      userId: user.id,
      projectId: edit.projectId,
      editId,
      editVersionId: edit.currentVersionId,
      styleId: edit.styleId,
      type: value ? 'favourite' : 'unfavourite',
    });
  });
  try {
    const settings = await getSettings();
    const affinity = { ...settings.preferences.styleAffinity };
    affinity[edit.styleId] = Math.max(0, (affinity[edit.styleId] ?? 0) + (value ? 1 : -1));
    await updateSettings({ preferences: { styleAffinity: affinity } }, user.id);
  } catch (err) {
    // The favourite itself is saved; a failed preference update only affects future suggestions.
    getLogger().warn({ err, editId }, 'could not update style affinity');
  }
  return { isFavourite: value };
}

/**
 * Creates a new version of an edit (revise with an instruction, or a fresh regenerate). The previous version
 * is kept untouched; the new one becomes current and edits.revise plans it.
 */
export async function createEditVersion(
  editId: string,
  user: SessionUser,
  input: { mode: 'revise' | 'regenerate'; instruction: string },
): Promise<{ version: EditVersion; jobId: string }> {
  const { edit } = await getAccessibleEdit(editId, user);
  const db = getDb();
  if (edit.currentVersionId) {
    const current = await db.query.editVersions.findFirst({ columns: { status: true }, where: eq(schema.editVersions.id, edit.currentVersionId) });
    if (current && (current.status === 'planning' || current.status === 'planned' || current.status === 'rendering_preview')) {
      throw new AppError('CONFLICT', 'This edit is still being made. Wait for the preview before changing it.');
    }
  }
  const versionId = newId();
  const version = await db.transaction(async (tx) => {
    // Lock the edit so two quick clicks cannot both take the same version number.
    await tx.execute(sql`select id from ${schema.edits} where ${schema.edits.id} = ${editId} for update`);
    const [{ top } = { top: 0 }] = await tx.select({ top: max(schema.editVersions.versionNo) }).from(schema.editVersions).where(eq(schema.editVersions.editId, editId));
    const locked = await tx.query.edits.findFirst({ columns: { currentVersionId: true }, where: eq(schema.edits.id, editId) });
    const [row] = await tx
      .insert(schema.editVersions)
      .values({
        id: versionId,
        editId,
        versionNo: (top ?? 0) + 1,
        parentVersionId: locked?.currentVersionId ?? null,
        origin: input.mode,
        instruction: input.instruction,
        status: 'planning',
        statusMessage: input.mode === 'revise' ? 'Waiting to apply your changes' : 'Waiting to make a fresh take',
      })
      .returning();
    await tx.update(schema.edits).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(schema.edits.id, editId));
    await tx.insert(schema.feedbackEvents).values({
      id: newId(),
      userId: user.id,
      projectId: edit.projectId,
      editId,
      editVersionId: versionId,
      styleId: edit.styleId,
      type: input.mode,
      data: input.instruction ? { instruction: input.instruction } : {},
    });
    if (!row) throw new AppError('INTERNAL', 'The new version could not be recorded.');
    return row;
  });
  try {
    const job = await createTrackedJob({ type: 'edits.revise', payload: { editId, projectId: edit.projectId, newVersionId: versionId, mode: input.mode } });
    return { version, jobId: job.id };
  } catch (err) {
    await db.update(schema.editVersions).set({ status: 'failed', statusMessage: 'Could not start. Please try again.', updatedAt: new Date() }).where(eq(schema.editVersions.id, versionId));
    throw err;
  }
}

/** Shows an earlier (or later) version on the card. Nothing is deleted. */
export async function setCurrentVersion(editId: string, user: SessionUser, versionId: string): Promise<{ currentVersionId: string }> {
  const { edit } = await getAccessibleEdit(editId, user);
  const version = await getDb().query.editVersions.findFirst({ columns: { id: true, editId: true }, where: eq(schema.editVersions.id, versionId) });
  if (!version || version.editId !== edit.id) throw new AppError('NOT_FOUND', 'That version does not belong to this edit.');
  await getDb().update(schema.edits).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(schema.edits.id, editId));
  return { currentVersionId: versionId };
}

/** Export status as sent back by the export route. */
export interface ExportStateDto {
  versionId: string;
  exportStatus: EditVersion['exportStatus'];
  exportMessage: string;
  jobId: string | null;
}

/**
 * Queues the full-quality 1080×1920 render of one version. Idempotent: while an export is queued or
 * rendering (or already ready) the current state is returned and no second render is queued.
 */
export async function requestExport(versionId: string, user: SessionUser): Promise<ExportStateDto> {
  const { version, edit } = await getAccessibleVersion(versionId, user);
  const db = getDb();
  const activeJob = async () =>
    (
      await db.query.jobs.findFirst({
        columns: { id: true },
        where: and(eq(schema.jobs.refId, versionId), eq(schema.jobs.type, 'render.export'), inArray(schema.jobs.status, [...ACTIVE_JOB_STATUSES])),
      })
    )?.id ?? null;
  if (version.exportStatus === 'queued' || version.exportStatus === 'rendering' || version.exportStatus === 'ready') {
    return { versionId, exportStatus: version.exportStatus, exportMessage: version.exportMessage, jobId: await activeJob() };
  }
  if (version.status !== 'preview_ready' || !version.plan) {
    throw new AppError('CONFLICT', 'This version is not ready yet. Wait for its preview, then export.');
  }
  const claimed = await db
    .update(schema.editVersions)
    .set({ exportStatus: 'queued', exportMessage: 'Waiting to export', updatedAt: new Date() })
    .where(and(eq(schema.editVersions.id, versionId), inArray(schema.editVersions.exportStatus, ['none', 'failed'])))
    .returning({ exportStatus: schema.editVersions.exportStatus, exportMessage: schema.editVersions.exportMessage });
  if (claimed.length === 0) {
    const latest = await db.query.editVersions.findFirst({ columns: { exportStatus: true, exportMessage: true }, where: eq(schema.editVersions.id, versionId) });
    return { versionId, exportStatus: latest?.exportStatus ?? 'queued', exportMessage: latest?.exportMessage ?? '', jobId: await activeJob() };
  }
  try {
    const job = await createTrackedJob({ type: 'render.export', payload: { editVersionId: versionId, projectId: edit.projectId }, singletonKey: `export:${versionId}` });
    return { versionId, exportStatus: 'queued', exportMessage: 'Waiting to export', jobId: job.id };
  } catch (err) {
    await db
      .update(schema.editVersions)
      .set({ exportStatus: 'failed', exportMessage: 'The export could not start. Please try again.', updatedAt: new Date() })
      .where(eq(schema.editVersions.id, versionId));
    throw err;
  }
}

/** Expiring link to a version's full-quality export (default) or its preview, with a friendly file name. */
export async function downloadLink(versionId: string, user: SessionUser, kind: 'export' | 'preview'): Promise<{ url: string; filename: string; expiresInSeconds?: number }> {
  const { version, edit, project } = await getAccessibleVersion(versionId, user);
  const styleName = STYLES[edit.styleId as StyleId]?.name ?? edit.styleId;
  if (kind === 'preview') {
    if (version.status !== 'preview_ready' || !version.previewKey) throw new AppError('CONFLICT', 'The preview for this version is not ready yet.');
    const filename = downloadNameFor([project.title, styleName, `v${version.versionNo}`, 'preview'], 'mp4');
    return { url: await signedUrlFor(version.previewKey, { downloadName: filename, contentType: 'video/mp4' }), filename };
  }
  if (version.exportStatus !== 'ready' || !version.exportKey) throw new AppError('CONFLICT', 'The full-quality video is not ready yet. Press "Export full quality" first.');
  const filename = downloadNameFor([project.title, styleName, `v${version.versionNo}`], 'mp4');
  const url = await signedUrlFor(version.exportKey, { downloadName: filename, contentType: 'video/mp4' });
  await getDb()
    .insert(schema.feedbackEvents)
    .values({ id: newId(), userId: user.id, projectId: project.id, editId: edit.id, editVersionId: versionId, styleId: edit.styleId, type: 'download' })
    .catch((err: unknown) => getLogger().warn({ err, versionId }, 'could not record download feedback'));
  return { url, filename };
}
