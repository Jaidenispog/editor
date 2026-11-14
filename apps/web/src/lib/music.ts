import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { AppError, MusicLicenceSchema, newId, type MusicLicence } from '@studio/core';
import { schema, type MusicTrack } from '@studio/db';
import { assertSafeKey, storageKeys } from '@studio/storage';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';
import { getBlobStore } from './storage.js';

/** Body for POST /api/music: the file must already be in storage under music/ (uploads are wired by the Studio UI). */
export const CreateMusicTrackSchema = z.object({
  title: z.string().trim().min(1, 'Give the track a title').max(160),
  artist: z.string().trim().max(160).default(''),
  storageKey: z.string().min(1).max(400),
  mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i, 'Expected an audio file type such as audio/mpeg'),
  byteSize: z.number().int().positive(),
  durationSec: z.number().positive().max(60 * 60).optional(),
  licence: MusicLicenceSchema,
  /** When true the owner confirms they hold the rights described in the licence. */
  confirmLicence: z.boolean().optional(),
  moods: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
});

/** Body for PATCH /api/music/[id]. */
export const UpdateMusicTrackSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    artist: z.string().trim().max(160),
    moods: z.array(z.string().trim().min(1).max(40)).max(12),
    licence: MusicLicenceSchema,
    confirmLicence: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** Library track as sent to the browser (storage key omitted). */
export interface MusicTrackSummary {
  id: string;
  title: string;
  artist: string;
  mimeType: string;
  byteSize: number;
  durationSec: number | null;
  bpm: number | null;
  moods: string[];
  licence: MusicLicence;
  licenceConfirmed: boolean;
  status: MusicTrack['status'];
  statusMessage: string;
  createdAt: string;
}

/** Converts a row to the browser-safe summary. */
export function toMusicSummary(t: MusicTrack): MusicTrackSummary {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    mimeType: t.mimeType,
    byteSize: t.byteSize,
    durationSec: t.durationSec,
    bpm: t.bpm,
    moods: t.moods,
    licence: t.licence,
    licenceConfirmed: Boolean(t.licence.confirmedByOwnerAt),
    status: t.status,
    statusMessage: t.statusMessage,
    createdAt: t.createdAt.toISOString(),
  };
}

function applyConfirmation(licence: MusicLicence, confirm: boolean | undefined, previous: MusicLicence | null): MusicLicence {
  if (confirm === true) return { ...licence, confirmedByOwnerAt: previous?.confirmedByOwnerAt ?? new Date().toISOString() };
  if (confirm === false) return { ...licence, confirmedByOwnerAt: null };
  // The browser cannot set the confirmation timestamp itself; keep whatever was recorded before.
  return { ...licence, confirmedByOwnerAt: previous?.confirmedByOwnerAt ?? null };
}

/** Library tracks (not scoped to a project), newest first. */
export async function listLibraryTracks(): Promise<MusicTrackSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.musicTracks)
    .where(and(isNull(schema.musicTracks.projectId), isNull(schema.musicTracks.deletedAt)))
    .orderBy(desc(schema.musicTracks.createdAt));
  return rows.map(toMusicSummary);
}

/** Loads a non-deleted track or throws NOT_FOUND. */
export async function getTrackOrThrow(id: string): Promise<MusicTrack> {
  const t = await getDb().query.musicTracks.findFirst({ where: and(eq(schema.musicTracks.id, id), isNull(schema.musicTracks.deletedAt)) });
  if (!t) throw new AppError('NOT_FOUND', 'That music track could not be found.');
  return t;
}

/** Registers an already-uploaded audio file as a library track and queues beat analysis. */
export async function createLibraryTrack(userId: string, input: z.infer<typeof CreateMusicTrackSchema>): Promise<MusicTrackSummary> {
  try {
    assertSafeKey(input.storageKey);
  } catch {
    throw new AppError('VALIDATION', 'The stored file reference is not valid.', { details: { field: 'storageKey' } });
  }
  if (!input.storageKey.startsWith('music/')) {
    throw new AppError('VALIDATION', 'Music files must be stored in the music library area.', { details: { field: 'storageKey' } });
  }
  const stat = await getBlobStore().stat(input.storageKey);
  if (!stat) throw new AppError('VALIDATION', 'The uploaded music file could not be found. Please upload it again.', { details: { field: 'storageKey' } });
  const id = newId();
  const inserted = await getDb()
    .insert(schema.musicTracks)
    .values({
      id,
      projectId: null,
      title: input.title,
      artist: input.artist,
      source: 'upload',
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      byteSize: stat.size || input.byteSize,
      durationSec: input.durationSec ?? null,
      moods: input.moods,
      licence: applyConfirmation(input.licence, input.confirmLicence, null),
      status: 'uploaded',
      statusMessage: 'Waiting to be analysed',
    })
    .returning();
  const track = inserted[0];
  if (!track) throw new AppError('INTERNAL', 'The track could not be saved.');
  await createTrackedJob({ type: 'music.analyse', payload: { trackId: id }, projectId: null, refId: id });
  await writeAudit({ userId, action: 'music.created', entityType: 'music_track', entityId: id });
  return toMusicSummary(track);
}

/** Updates title, artist, moods or licence details. */
export async function updateTrack(id: string, userId: string, input: z.infer<typeof UpdateMusicTrackSchema>): Promise<MusicTrackSummary> {
  const track = await getTrackOrThrow(id);
  const licenceSource = input.licence ?? track.licence;
  // New licence details confirmed again are dated now; confirming unchanged details keeps the first date.
  const previous = input.licence !== undefined && input.confirmLicence === true ? null : track.licence;
  const licence = input.licence !== undefined || input.confirmLicence !== undefined ? applyConfirmation(licenceSource, input.confirmLicence, previous) : track.licence;
  const updated = await getDb()
    .update(schema.musicTracks)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.artist !== undefined ? { artist: input.artist } : {}),
      ...(input.moods !== undefined ? { moods: input.moods } : {}),
      licence,
      updatedAt: new Date(),
    })
    .where(eq(schema.musicTracks.id, id))
    .returning();
  const row = updated[0];
  if (!row) throw new AppError('NOT_FOUND', 'That music track could not be found.');
  if (input.licence !== undefined || input.confirmLicence !== undefined) {
    await writeAudit({ userId, action: 'music.licence_updated', entityType: 'music_track', entityId: id, data: { confirmed: Boolean(licence.confirmedByOwnerAt) } });
  }
  return toMusicSummary(row);
}

/**
 * Removes a track from the library and deletes its stored audio. Edits already rendered keep their sound;
 * new edits can no longer use the track.
 */
export async function deleteTrack(id: string, userId: string): Promise<void> {
  const track = await getTrackOrThrow(id);
  await getDb().update(schema.musicTracks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.musicTracks.id, id));
  try {
    const store = getBlobStore();
    if (track.storageKey.startsWith(`${storageKeys.musicPrefix(id)}/`)) await store.deletePrefix(storageKeys.musicPrefix(id));
    else await store.delete(track.storageKey);
  } catch (err) {
    getLogger().warn({ err, trackId: id }, 'could not remove stored music file');
  }
  await writeAudit({ userId, action: 'music.deleted', entityType: 'music_track', entityId: id });
}
