import { ApproveBatchSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { approveBatch } from '@/lib/email';

/** POST /api/email/messages/approve-batch (owner): approves up to 100 drafts; blocked ones come back with reasons. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const { ids } = await parseJson(req, ApproveBatchSchema);
  return approveBatch(user, ids);
});
