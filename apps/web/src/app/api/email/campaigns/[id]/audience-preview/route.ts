import { AudiencePreviewSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { audiencePreview } from '@/lib/email';

/** POST /api/email/campaigns/[id]/audience-preview (owner): who receives it, who is left out and why, and the hash to approve. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  const body = await parseJson(req, AudiencePreviewSchema);
  return audiencePreview(params.id, body.search);
});
