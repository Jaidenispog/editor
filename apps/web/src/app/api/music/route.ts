import { handleApi, parseJson } from '@/lib/api';
import { CreateMusicTrackSchema, createLibraryTrack, listLibraryTracks } from '@/lib/music';

/** GET /api/music — library tracks with licence and analysis status. */
export const GET = handleApi(async () => ({ tracks: await listLibraryTracks() }));

/** POST /api/music — registers an already-uploaded audio file (storageKey under music/) and queues music.analyse. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, CreateMusicTrackSchema);
  const track = await createLibraryTrack(user.id, body);
  return Response.json({ track }, { status: 201 });
});
