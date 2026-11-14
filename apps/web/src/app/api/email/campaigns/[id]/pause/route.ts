import { handleApi, requireOwner } from '@/lib/api';
import { changeCampaign } from '@/lib/email';

/** POST /api/email/campaigns/[id]/pause (owner). */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return changeCampaign(user, params.id, 'pause');
});
