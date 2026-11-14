import { handleApi } from '@/lib/api';
import { versionMusic } from '@/lib/studio-edits';

/**
 * GET /api/music/versions/[id] — the music of one edit version (studio access): track and licence chip, clearance,
 * the plan's sound settings, beats and loudness for the song-section strip, and the music-free export's state.
 */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => versionMusic(params.id, user));
