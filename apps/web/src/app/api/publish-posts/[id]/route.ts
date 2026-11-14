import { PatchPublishPostSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { deleteDraftPost, getPublishPost, patchPublishPost, postHistory } from '@/lib/publishing';

/** GET /api/publish-posts/[id] (session): the post with its destinations, messages, allowed actions and history. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => ({ ...(await getPublishPost(params.id, user)), history: await postHistory(params.id, user) }));

/** PATCH /api/publish-posts/[id] (session; owner once approved): change time, caption, cover or destinations. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => patchPublishPost(params.id, await parseJson(req, PatchPublishPostSchema), user));

/** DELETE /api/publish-posts/[id] (session): drafts only. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  await deleteDraftPost(params.id, user);
});
