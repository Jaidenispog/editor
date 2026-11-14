import { handleApi, parseJson } from '@/lib/api';
import { FavouriteSchema } from '@/lib/shared/studio-schemas';
import { setFavourite } from '@/lib/studio-edits';

/** POST /api/edits/[id]/favourite — { value } (records feedback and style affinity). */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { value } = await parseJson(req, FavouriteSchema);
  return setFavourite(params.id, user, value);
});
