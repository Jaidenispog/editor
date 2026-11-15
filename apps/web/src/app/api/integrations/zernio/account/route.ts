import { ZernioAccountChoiceSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { chooseZernioAccount } from '@/lib/publishing';

/** POST /api/integrations/zernio/account (owner): the TikTok account to post to, from the ones Zernio listed. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, ZernioAccountChoiceSchema);
  return chooseZernioAccount(body.zernioAccountId, user);
});
