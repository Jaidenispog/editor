import 'server-only';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  AppError,
  MusicLicenceInputSchema,
  STYLE_IDS,
  artistsWithoutMatch,
  licenceStateOf,
  musicTasteFrom,
  newId,
  normaliseLicence,
  rankTracksForPreferences,
  type LicenceState,
  type MusicLicence,
  type StyleId,
} from '@studio/core';
import { schema, type MusicTrack } from '@studio/db';
import { assertSafeKey, storageKeys } from '@studio/storage';
import { z } from 'zod';
import type { SessionUser } from './auth.js';
import { writeAudit } from './audit.js';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';
import { signedUrlFor } from './media-links.js';
import { getSettings } from './settings.js';
import type { MusicSuggestionsDto } from './shared/studio-dto.js';
import { getBlobStore } from './storage.js';

const TagListSchema = z.array(z.string().trim().min(1).max(40)).max(12);

/** Body for POST /api/music: the file must already be in storage under music/ (uploads are wired by the Studio UI). */
export const CreateMusicTrackSchema = z.object({
  title: z.string().trim().min(1, 'Give the track a title').max(160),
  artist: z.string().trim().max(160).default(''),
  storageKey: z.string().min(1).max(400),
  mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i, 'Expected an audio file type such as audio/mpeg'),
  byteSize: z.number().int().positive(),
  durationSec: z.number().positive().max(60 * 60).optional(),
  /** The licence passport: CC BY-NC is refused, CC BY needs its credit line, Meta Sound Collection is locked to Meta. */
  licence: MusicLicenceInputSchema,
  /** When true the owner confirms they hold the rights described in the licence. */
  confirmLicence: z.boolean().optional(),
  moods: TagListSchema.default([]),
  genres: TagListSchema.default([]),
});

/** Body for PATCH /api/music/[id]. */
export const UpdateMusicTrackSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    artist: z.string().trim().max(160),
    moods: TagListSchema,
    genres: TagListSchema,
    licence: MusicLicenceInputSchema,
    confirmLicence: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/** Query for GET /api/music/suggestions. */
export const SuggestionsQuerySchema = z.object({
  durationSec: z.coerce.number().int().min(8).max(90).default(25),
  styleId: z.enum(STYLE_IDS).optional(),
});

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
  genres: string[];
  licence: MusicLicence;
  licenceConfirmed: boolean;
  /** The licence chip: confirmed, not confirmed, expired, or Instagram & Facebook only. */
  licenceState: LicenceState;
  status: MusicTrack['status'];
  statusMessage: string;
  createdAt: string;
}

/** Converts a row to the browser-safe summary. */
export function toMusicSummary(t: MusicTrack): MusicTrackSummary {
  const licence = normaliseLicence(t.licence);
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    mimeType: t.mimeType,
    byteSize: t.byteSize,
    durationSec: t.durationSec,
    bpm: t.bpm,
    moods: t.moods,
    genres: t.genres ?? [],
    licence,
    licenceConfirmed: Boolean(licence.confirmedByOwnerAt),
    licenceState: licenceStateOf(licence),
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
export async function createLibraryTrack(userId: string, input: z.input<typeof CreateMusicTrackSchema>): Promise<MusicTrackSummary> {
  // Parsed here as well as in the routes, so every way in (the upload completion included) applies the passport rules.
  const data = CreateMusicTrackSchema.parse(input);
  try {
    assertSafeKey(data.storageKey);
  } catch {
    throw new AppError('VALIDATION', 'The stored file reference is not valid.', { details: { field: 'storageKey' } });
  }
  if (!data.storageKey.startsWith('music/')) {
    throw new AppError('VALIDATION', 'Music files must be stored in the music library area.', { details: { field: 'storageKey' } });
  }
  const stat = await getBlobStore().stat(data.storageKey);
  if (!stat) throw new AppError('VALIDATION', 'The uploaded music file could not be found. Please upload it again.', { details: { field: 'storageKey' } });
  const id = newId();
  const inserted = await getDb()
    .insert(schema.musicTracks)
    .values({
      id,
      projectId: null,
      title: data.title,
      artist: data.artist,
      source: 'upload',
      storageKey: data.storageKey,
      mimeType: data.mimeType,
      byteSize: stat.size || data.byteSize,
      durationSec: data.durationSec ?? null,
      moods: data.moods,
      genres: data.genres,
      licence: applyConfirmation(data.licence, data.confirmLicence, null),
      status: 'uploaded',
      statusMessage: 'Waiting to be analysed',
    })
    .returning();
  const track = inserted[0];
  if (!track) throw new AppError('INTERNAL', 'The track could not be saved.');
  await createTrackedJob({ type: 'music.analyse', payload: { trackId: id }, projectId: null, refId: id });
  await writeAudit({ userId, action: 'music.created', entityType: 'music_track', entityId: id, data: { licenceKind: data.licence.kind } });
  return toMusicSummary(track);
}

/**
 * Updates title, artist, moods, genres or licence details. Licence changes are the owner's: staff may tag tracks
 * but never confirm or change what a licence covers. New licence details confirmed again are dated now.
 */
export async function updateTrack(id: string, user: Pick<SessionUser, 'id' | 'role'>, input: z.infer<typeof UpdateMusicTrackSchema>): Promise<MusicTrackSummary> {
  const licenceChange = input.licence !== undefined || input.confirmLicence !== undefined;
  if (licenceChange && user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can change or confirm a music licence.');
  const track = await getTrackOrThrow(id);
  const licenceSource = input.licence ?? track.licence;
  // New licence details confirmed again are dated now; confirming unchanged details keeps the first date.
  const previous = input.licence !== undefined && input.confirmLicence === true ? null : track.licence;
  const licence = licenceChange ? applyConfirmation(normaliseLicence(licenceSource), input.confirmLicence, previous) : track.licence;
  const updated = await getDb()
    .update(schema.musicTracks)
    .set({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.artist !== undefined ? { artist: input.artist } : {}),
      ...(input.moods !== undefined ? { moods: input.moods } : {}),
      ...(input.genres !== undefined ? { genres: input.genres } : {}),
      licence,
      updatedAt: new Date(),
    })
    .where(eq(schema.musicTracks.id, id))
    .returning();
  const row = updated[0];
  if (!row) throw new AppError('NOT_FOUND', 'That music track could not be found.');
  if (licenceChange) {
    await writeAudit({ userId: user.id, action: 'music.licence_updated', entityType: 'music_track', entityId: id, data: { confirmed: Boolean(licence.confirmedByOwnerAt), kind: licence.kind } });
  }
  return toMusicSummary(row);
}

/**
 * Removes a track from the library and deletes its stored audio. Edits already rendered keep their sound;
 * new edits can no longer use the track, and exports of versions that use it are blocked (their licence can no
 * longer be checked) until a music-free version is made.
 */
export async function deleteTrack(id: string, user: Pick<SessionUser, 'id' | 'role'>): Promise<void> {
  if (user.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can remove music from the library.');
  const track = await getTrackOrThrow(id);
  await getDb().update(schema.musicTracks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.musicTracks.id, id));
  try {
    const store = getBlobStore();
    if (track.storageKey.startsWith(`${storageKeys.musicPrefix(id)}/`)) await store.deletePrefix(storageKeys.musicPrefix(id));
    else await store.delete(track.storageKey);
  } catch (err) {
    getLogger().warn({ err, trackId: id }, 'could not remove stored music file');
  }
  await writeAudit({ userId: user.id, action: 'music.deleted', entityType: 'music_track', entityId: id });
}

/** Expiring link to a track's audio file, for "Listen" in the Sound panel and the music library. */
export async function listenLink(id: string): Promise<{ url: string; expiresInSeconds: number; mimeType: string }> {
  const track = await getTrackOrThrow(id);
  if (track.projectId !== null) throw new AppError('NOT_FOUND', 'That music track could not be found.');
  return { url: await signedUrlFor(track.storageKey, { contentType: track.mimeType }), expiresInSeconds: getEnv().MEDIA_LINK_TTL_SECONDS, mimeType: track.mimeType };
}

/**
 * "Suggested for you": the owner's own library ranked by their music taste and the edit's length and style. Never
 * searches anywhere else and never picks a track by itself.
 */
export async function musicSuggestions(query: z.infer<typeof SuggestionsQuerySchema>): Promise<MusicSuggestionsDto> {
  const [rows, settings] = await Promise.all([
    getDb()
      .select()
      .from(schema.musicTracks)
      .where(and(isNull(schema.musicTracks.projectId), isNull(schema.musicTracks.deletedAt))),
    getSettings(),
  ]);
  const taste = musicTasteFrom(settings.preferences);
  const tracks = rows.map((t) => ({ ...t, genres: t.genres ?? [] }));
  return {
    tracks: rankTracksForPreferences(tracks, taste, { durationSec: query.durationSec, styleId: (query.styleId as StyleId | undefined) ?? null }),
    notes: artistsWithoutMatch(tracks, taste),
  };
}
