import { ApproveCampaignSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { approveCampaign } from '@/lib/email';

/** POST /api/email/campaigns/[id]/approve (owner): 409 when the audience changed since the preview. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return approveCampaign(user, params.id, await parseJson(req, ApproveCampaignSchema));
});
