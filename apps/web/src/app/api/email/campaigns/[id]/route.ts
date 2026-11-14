import { UpdateCampaignSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { getCampaign, updateCampaign } from '@/lib/email';

/** GET /api/email/campaigns/[id] (owner). */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return getCampaign(params.id);
});

/** PATCH /api/email/campaigns/[id] (owner): only while the campaign is a draft. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return updateCampaign(user, params.id, await parseJson(req, UpdateCampaignSchema));
});
