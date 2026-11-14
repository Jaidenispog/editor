import { ApprovePublishPostsSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { approvePublishPosts } from '@/lib/publishing';

/** POST /api/publish-posts/approve (owner): approves drafts and starts preparing them. Idempotent. */
export const POST = handleApi(async ({ req, user }) => approvePublishPosts(await parseJson(req, ApprovePublishPostsSchema), user));
