import { ConfirmPostedSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { confirmPosted } from '@/lib/publishing';

/** POST /api/publish-targets/[id]/confirm-posted (session): "I've posted it", with an optional link to the post. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, ConfirmPostedSchema);
  return confirmPosted(params.id, body.url, user);
});
