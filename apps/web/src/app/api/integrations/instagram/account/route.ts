import { InstagramAccountIdSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { setInstagramAccountId } from '@/lib/publishing';

/** POST /api/integrations/instagram/account (owner): the Instagram account ID, checked by the read-only job. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, InstagramAccountIdSchema);
  return setInstagramAccountId(body.igUserId, user);
});
