import { handleApi } from '@/lib/api';
import { SuggestionsQuerySchema, musicSuggestions } from '@/lib/music';

/**
 * GET /api/music/suggestions?durationSec=25&styleId=beat_montage — the owner's own tracks ranked by their music
 * taste, with plain reasons; unusable tracks are listed last with the reason. Nothing is chosen automatically.
 */
export const GET = handleApi(async ({ req }) => {
  const p = req.nextUrl.searchParams;
  const query = SuggestionsQuerySchema.parse({ durationSec: p.get('durationSec') ?? undefined, styleId: p.get('styleId') ?? undefined });
  return musicSuggestions(query);
});
