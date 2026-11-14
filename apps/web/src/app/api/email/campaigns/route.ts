import { CreateCampaignSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { createCampaign, listCampaigns } from '@/lib/email';

/** GET /api/email/campaigns (owner). */
export const GET = handleApi(async ({ user }) => {
  requireOwner(user);
  return listCampaigns();
});

/** POST /api/email/campaigns (owner): a draft campaign. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return createCampaign(user, await parseJson(req, CreateCampaignSchema));
});
