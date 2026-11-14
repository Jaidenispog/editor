import { LiftSuppressionSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { liftSuppression } from '@/lib/email';

/** POST /api/email/suppressions/[id]/lift (owner): lifts a bounce or complaint block under the design's rules. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return liftSuppression(user, params.id, await parseJson(req, LiftSuppressionSchema));
});
