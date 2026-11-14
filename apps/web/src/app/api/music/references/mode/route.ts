import { handleApi, parseJson } from '@/lib/api';
import { ReferenceModeSchema, setReferenceMode } from '@/lib/music-references';

/**
 * PUT /api/music/references/mode — { mode: 'link_only' | 'embed', acknowledgeSpotifyTerms?: true } (owner only).
 * The embed is refused with 409 until the terms and privacy pages exist and Spotify's terms are acknowledged.
 */
export const PUT = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, ReferenceModeSchema);
  return setReferenceMode(user, body);
});
