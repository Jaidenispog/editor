import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { chooseDraft } from '@/lib/website';

/** POST /api/website/edits/[id]/choose-draft (owner) `{ index }`: copies one AI option into the change. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ index: z.number().int().min(0).max(2) }));
  return { edit: await chooseDraft(user, params.id, body.index) };
});
