import { handleApi, parseJson } from '@/lib/api';
import { DismissSchema, setDismissed } from '@/lib/preferences';

/** POST /api/edits/[id]/dismiss — { value }: "Hide this edit" / "Show again" (records feedback; nothing is deleted). */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const { value } = await parseJson(req, DismissSchema);
  return setDismissed(params.id, user, value);
});
