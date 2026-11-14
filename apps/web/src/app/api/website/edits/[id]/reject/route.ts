import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { rejectEdit } from '@/lib/website';

/** POST /api/website/edits/[id]/reject (owner) `{ reason? }`: dismisses a change. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ reason: z.string().trim().max(200).optional() }));
  return { edit: await rejectEdit(user, params.id, body.reason || undefined) };
});
