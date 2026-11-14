import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { patchEdit } from '@/lib/website';

/** PATCH /api/website/edits/[id] (owner) `{ after }`: edits the wording; returns soft warnings for claims. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ after: z.string().max(5000) }));
  return patchEdit(user, params.id, body.after);
});
