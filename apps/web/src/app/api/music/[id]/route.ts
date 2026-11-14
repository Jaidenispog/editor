import { handleApi, parseJson } from '@/lib/api';
import { UpdateMusicTrackSchema, deleteTrack, getTrackOrThrow, toMusicSummary, updateTrack } from '@/lib/music';

/** GET /api/music/[id] — one library track. */
export const GET = handleApi<{ id: string }>(async ({ params }) => ({ track: toMusicSummary(await getTrackOrThrow(params.id)) }));

/** PATCH /api/music/[id] — title, artist, moods, licence details or licence confirmation. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, UpdateMusicTrackSchema);
  return { track: await updateTrack(params.id, user.id, body) };
});

/** DELETE /api/music/[id] — removes the track from the library and deletes its audio file. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  await deleteTrack(params.id, user.id);
  return { ok: true };
});
