import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AppError, newId } from '@studio/core';
import { schema, type UploadSession } from '@studio/db';
import { storageKeys, type MultipartPart, type MultipartUpload } from '@studio/storage';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';
import { createLibraryTrack } from './music.js';
import { getBlobStore } from './storage.js';
import { getAccessibleProject } from './studio-access.js';
import type { CompleteUploadInput, CreateUploadInput } from './shared/studio-schemas.js';
import { UPLOAD_PART_SIZE, UPLOAD_SESSION_TTL_HOURS, checkUploadFile, expectedPartSize, missingParts, partCountFor } from './shared/upload-math.js';

/** What the storage driver needs to resume a multipart upload, kept in upload_sessions.driverState. */
interface DriverState {
  uploadId: string;
  key: string;
  /** Id the finished clip (media_assets) or music track will get. */
  plannedId: string;
  /** Part number → stored part (ETag/size). */
  parts: Record<string, { etag: string; size: number }>;
  /** Set while one request is assembling the file, so a double click cannot complete it twice. */
  completingSince?: string;
  [key: string]: unknown;
}

/** Response of POST /api/projects/[id]/uploads and GET /api/uploads/[id]. */
export interface UploadSessionDto {
  uploadId: string;
  kind: 'video' | 'audio';
  filename: string;
  size: number;
  partSize: number;
  partCount: number;
  receivedParts: number[];
  status: UploadSession['status'];
  /** Clip or track id once completed. */
  assetId: string | null;
}

/** A completion claim older than this is treated as abandoned (the request crashed). */
const STALE_COMPLETION_MS = 5 * 60 * 1000;

function toDto(row: UploadSession): UploadSessionDto {
  return {
    uploadId: row.id,
    kind: row.kind === 'audio' ? 'audio' : 'video',
    filename: row.originalFilename,
    size: row.totalBytes,
    partSize: row.partSizeBytes,
    partCount: row.partCount,
    receivedParts: [...row.receivedParts].sort((a, b) => a - b),
    status: row.status,
    assetId: row.assetId,
  };
}

function driverStateOf(row: UploadSession): DriverState {
  const s = row.driverState as Partial<DriverState>;
  if (typeof s.uploadId !== 'string' || typeof s.key !== 'string' || typeof s.plannedId !== 'string') {
    throw new AppError('CONFLICT', 'This upload can no longer be resumed. Please add the file again.');
  }
  return { ...s, uploadId: s.uploadId, key: s.key, plannedId: s.plannedId, parts: s.parts ?? {} };
}

function multipartOf(state: DriverState): MultipartUpload {
  return { uploadId: state.uploadId, key: state.key };
}

/** Loads an upload session the user may use (its project must still exist), or throws NOT_FOUND. */
export async function getAccessibleUpload(uploadId: string, user: SessionUser): Promise<UploadSession> {
  const row = await getDb().query.uploadSessions.findFirst({ where: eq(schema.uploadSessions.id, uploadId) });
  if (!row) throw new AppError('NOT_FOUND', 'That upload could not be found. Please add the file again.');
  await getAccessibleProject(row.projectId, user).catch(() => {
    throw new AppError('NOT_FOUND', 'That upload could not be found. Please add the file again.');
  });
  return row;
}

function assertOpen(row: UploadSession): void {
  if (row.status === 'completed') throw new AppError('CONFLICT', 'This file has already finished uploading.');
  if (row.status !== 'open') throw new AppError('CONFLICT', 'This upload was cancelled. Please add the file again.');
  if (row.expiresAt.getTime() < Date.now()) throw new AppError('CONFLICT', 'This upload has expired. Please add the file again.');
}

/**
 * Starts a chunked upload: checks the file type and size, opens a multipart upload in storage and records an
 * upload_sessions row. The browser then sends 8 MiB parts and calls complete.
 */
export async function createUpload(projectId: string, user: SessionUser, input: CreateUploadInput): Promise<UploadSessionDto> {
  const project = await getAccessibleProject(projectId, user);
  const check = checkUploadFile({ filename: input.filename, mimeType: input.mimeType, kind: input.kind });
  if (!check.ok) throw new AppError('VALIDATION', check.reason, { details: [{ path: 'filename', message: check.reason }] });
  const max = getEnv().MAX_UPLOAD_BYTES;
  if (input.size > max) {
    const gb = (max / 1024 ** 3).toFixed(max >= 1024 ** 3 ? 1 : 2);
    throw new AppError('VALIDATION', `This file is too large. The limit is ${gb} GB per file.`, { details: [{ path: 'size', message: 'File too large' }] });
  }
  const partSize = UPLOAD_PART_SIZE;
  const partCount = partCountFor(input.size, partSize);
  if (partCount > 10_000) throw new AppError('VALIDATION', 'This file is too large to upload in one go.');
  const id = newId();
  const plannedId = newId();
  const targetKey = input.kind === 'video' ? storageKeys.assetOriginal(project.id, plannedId, check.extension) : storageKeys.musicOriginal(plannedId, check.extension);
  const store = getBlobStore();
  let upload: MultipartUpload;
  try {
    upload = await store.createMultipart(targetKey, { contentType: check.mimeType });
  } catch (err) {
    getLogger().error({ err, projectId }, 'could not start multipart upload');
    throw new AppError('INTERNAL', 'Storage is not reachable right now, so the upload could not start. Please try again shortly.', { cause: err });
  }
  const driverState: DriverState = { uploadId: upload.uploadId, key: upload.key, plannedId, parts: {} };
  const inserted = await getDb()
    .insert(schema.uploadSessions)
    .values({
      id,
      projectId: project.id,
      userId: user.id,
      kind: input.kind,
      originalFilename: input.filename,
      mimeType: check.mimeType,
      totalBytes: input.size,
      partSizeBytes: partSize,
      partCount,
      receivedParts: [],
      driverState,
      targetKey,
      status: 'open',
      expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_HOURS * 3600 * 1000),
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new AppError('INTERNAL', 'The upload could not be recorded.');
  return toDto(row);
}

/** Upload progress for resuming after a page reload. */
export async function getUpload(uploadId: string, user: SessionUser): Promise<UploadSessionDto> {
  return toDto(await getAccessibleUpload(uploadId, user));
}

/**
 * Stores part `n` (1-based). Idempotent: sending the same part again replaces it. The part's ETag and size are
 * merged into driverState and the part number into receivedParts in one atomic update, so parallel parts
 * never overwrite each other's records.
 */
export async function putUploadPart(uploadId: string, user: SessionUser, partNumber: number, body: Buffer): Promise<{ partNumber: number; receivedParts: number[] }> {
  const row = await getAccessibleUpload(uploadId, user);
  assertOpen(row);
  const expected = expectedPartSize(partNumber, row.totalBytes, row.partSizeBytes);
  if (expected === null) throw new AppError('VALIDATION', `Part ${partNumber} is outside this file.`);
  if (body.length !== expected) {
    throw new AppError('VALIDATION', `Part ${partNumber} arrived incomplete (${body.length} of ${expected} bytes). It will be sent again.`);
  }
  const state = driverStateOf(row);
  let part: MultipartPart;
  try {
    part = await getBlobStore().uploadPart(multipartOf(state), partNumber, body);
  } catch (err) {
    getLogger().error({ err, uploadId, partNumber }, 'part upload to storage failed');
    throw new AppError('INTERNAL', 'Part of the file could not be stored. It will be retried.', { cause: err });
  }
  const t = schema.uploadSessions;
  const record = JSON.stringify({ etag: part.etag, size: part.size });
  const updated = await getDb()
    .update(t)
    .set({
      driverState: sql`jsonb_set(${t.driverState}, ${`{parts,${partNumber}}`}::text[], ${record}::jsonb, true)`,
      receivedParts: sql`(select coalesce(jsonb_agg(v order by v::int), '[]'::jsonb) from (select distinct v from jsonb_array_elements(${t.receivedParts} || ${JSON.stringify([partNumber])}::jsonb) as e(v)) d)`,
      updatedAt: new Date(),
    })
    .where(and(eq(t.id, uploadId), eq(t.status, 'open')))
    .returning({ receivedParts: t.receivedParts });
  const after = updated[0];
  if (!after) throw new AppError('CONFLICT', 'This upload was cancelled. Please add the file again.');
  return { partNumber, receivedParts: [...after.receivedParts].sort((a, b) => a - b) };
}

/** Atomically marks the session as being completed; returns false when another request already is. */
async function claimCompletion(row: UploadSession): Promise<boolean> {
  const t = schema.uploadSessions;
  const staleBefore = new Date(Date.now() - STALE_COMPLETION_MS).toISOString();
  const claimed = await getDb()
    .update(t)
    .set({ driverState: sql`${t.driverState} || ${JSON.stringify({ completingSince: new Date().toISOString() })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(t.id, row.id), eq(t.status, 'open'), sql`(not (${t.driverState} ? 'completingSince') or ${t.driverState}->>'completingSince' < ${staleBefore})`))
    .returning({ id: t.id });
  return claimed.length > 0;
}

async function releaseCompletion(id: string): Promise<void> {
  const t = schema.uploadSessions;
  await getDb()
    .update(t)
    .set({ driverState: sql`${t.driverState} - 'completingSince'`, updatedAt: new Date() })
    .where(eq(t.id, id));
}

async function markCompleted(id: string, assetId: string): Promise<void> {
  const t = schema.uploadSessions;
  await getDb()
    .update(t)
    .set({ status: 'completed', assetId, driverState: sql`${t.driverState} - 'completingSince'`, updatedAt: new Date() })
    .where(eq(t.id, id));
}

/** Assembles the stored parts; tolerates a retry after an earlier attempt already assembled the file. */
async function assembleFile(row: UploadSession, state: DriverState): Promise<void> {
  const store = getBlobStore();
  const parts: MultipartPart[] = Object.entries(state.parts)
    .map(([n, p]) => ({ partNumber: Number(n), etag: p.etag, size: p.size }))
    .sort((a, b) => a.partNumber - b.partNumber);
  try {
    await store.completeMultipart(multipartOf(state), parts);
  } catch (err) {
    const stat = await store.stat(row.targetKey).catch(() => null);
    if (stat && stat.size === row.totalBytes) return;
    getLogger().error({ err, uploadId: row.id }, 'multipart completion failed');
    throw new AppError('INTERNAL', 'The file could not be put back together. Please try finishing the upload again.', { cause: err });
  }
  const stat = await store.stat(row.targetKey);
  if (!stat || stat.size !== row.totalBytes) {
    throw new AppError('INTERNAL', 'The uploaded file is incomplete. Please add it again.');
  }
}

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  return (base || 'Untitled track').slice(0, 160);
}

/**
 * Finishes an upload: checks every part arrived, assembles the file, then creates the clip (and queues
 * ingest.asset) or the library music track (and queues music.analyse). Safe to call twice: a completed
 * session returns the same id.
 */
export async function completeUpload(uploadId: string, user: SessionUser, input: CompleteUploadInput): Promise<{ assetId: string; kind: 'video' | 'audio' }> {
  const row = await getAccessibleUpload(uploadId, user);
  const kind = row.kind === 'audio' ? 'audio' : 'video';
  if (row.status === 'completed' && row.assetId) return { assetId: row.assetId, kind };
  assertOpen(row);
  const missing = missingParts(row.partCount, row.receivedParts);
  if (missing.length) {
    throw new AppError('CONFLICT', `The upload is not finished yet (${missing.length} part${missing.length === 1 ? '' : 's'} still to send).`, { details: { missingParts: missing } });
  }
  if (kind === 'audio') {
    if (!input.licence) throw new AppError('VALIDATION', 'Add the licence details for this track before finishing the upload.', { details: [{ path: 'licence', message: 'Required' }] });
    if (input.confirmLicence !== true) {
      throw new AppError('VALIDATION', 'Please confirm you hold the rights to use this music as described.', { details: [{ path: 'confirmLicence', message: 'Confirmation required' }] });
    }
  }
  if (!(await claimCompletion(row))) {
    const latest = await getAccessibleUpload(uploadId, user);
    if (latest.status === 'completed' && latest.assetId) return { assetId: latest.assetId, kind };
    throw new AppError('CONFLICT', 'This file is still being finished. Please wait a moment.');
  }
  const state = driverStateOf(row);
  try {
    await assembleFile(row, state);
    const assetId = kind === 'video' ? await finishVideo(row, state) : await finishAudio(row, user, input);
    await markCompleted(row.id, assetId);
    if (kind === 'video') await queueIngest(assetId, row.projectId);
    await writeAudit({ userId: user.id, action: kind === 'video' ? 'asset.uploaded' : 'music.uploaded', entityType: kind === 'video' ? 'media_asset' : 'music_track', entityId: assetId, data: { bytes: row.totalBytes } });
    return { assetId, kind };
  } catch (err) {
    await releaseCompletion(row.id).catch((e: unknown) => getLogger().warn({ err: e, uploadId }, 'could not release upload claim'));
    throw err;
  }
}

async function finishVideo(row: UploadSession, state: DriverState): Promise<string> {
  const db = getDb();
  const existing = await db.query.mediaAssets.findFirst({ columns: { id: true }, where: eq(schema.mediaAssets.id, state.plannedId) });
  if (existing) return existing.id;
  const last = await db
    .select({ sortOrder: schema.mediaAssets.sortOrder })
    .from(schema.mediaAssets)
    .where(and(eq(schema.mediaAssets.projectId, row.projectId), isNull(schema.mediaAssets.deletedAt)))
    .orderBy(desc(schema.mediaAssets.sortOrder))
    .limit(1);
  const sortOrder = (last[0]?.sortOrder ?? -1) + 1;
  await db.transaction(async (tx) => {
    await tx.insert(schema.mediaAssets).values({
      id: state.plannedId,
      projectId: row.projectId,
      kind: 'video',
      originalFilename: row.originalFilename,
      mimeType: row.mimeType,
      byteSize: row.totalBytes,
      sortOrder,
      originalKey: row.targetKey,
      status: 'uploaded',
      statusMessage: 'Waiting to be analysed',
    });
    await tx
      .update(schema.projects)
      .set({ status: sql`case when ${schema.projects.status} in ('draft', 'ready') then 'analysing' else ${schema.projects.status} end`, updatedAt: new Date() })
      .where(eq(schema.projects.id, row.projectId));
  });
  return state.plannedId;
}

/** Queues analysis of a new clip; if the queue is down the clip is marked failed so Retry is offered. */
async function queueIngest(assetId: string, projectId: string): Promise<void> {
  try {
    await createTrackedJob({ type: 'ingest.asset', payload: { assetId, projectId } });
  } catch (err) {
    await getDb()
      .update(schema.mediaAssets)
      .set({ status: 'failed', statusMessage: 'Analysis could not start. Press Retry to try again.', updatedAt: new Date() })
      .where(eq(schema.mediaAssets.id, assetId));
    throw err;
  }
}

async function finishAudio(row: UploadSession, user: SessionUser, input: CompleteUploadInput): Promise<string> {
  const existing = await getDb().query.musicTracks.findFirst({
    columns: { id: true },
    where: and(eq(schema.musicTracks.storageKey, row.targetKey), isNull(schema.musicTracks.deletedAt)),
  });
  if (existing) return existing.id;
  if (!input.licence) throw new AppError('VALIDATION', 'Add the licence details for this track before finishing the upload.');
  const track = await createLibraryTrack(user.id, {
    title: input.title?.trim() || titleFromFilename(row.originalFilename),
    artist: input.artist?.trim() ?? '',
    storageKey: row.targetKey,
    mimeType: row.mimeType,
    byteSize: row.totalBytes,
    licence: input.licence,
    confirmLicence: true,
    moods: input.moods ?? [],
  });
  return track.id;
}

/** Cancels an unfinished upload and deletes its staged parts. Completed uploads are left alone. */
export async function abortUpload(uploadId: string, user: SessionUser): Promise<void> {
  const row = await getAccessibleUpload(uploadId, user);
  if (row.status === 'completed') throw new AppError('CONFLICT', 'This file has already finished uploading. Remove the clip instead.');
  if (row.status !== 'open') return;
  try {
    await getBlobStore().abortMultipart(multipartOf(driverStateOf(row)));
  } catch (err) {
    getLogger().warn({ err, uploadId }, 'could not remove staged upload parts');
  }
  await getDb().update(schema.uploadSessions).set({ status: 'aborted', updatedAt: new Date() }).where(eq(schema.uploadSessions.id, uploadId));
}
