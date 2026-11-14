import { CreatePublishPostsSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { createPublishPosts, listPublishPosts } from '@/lib/publishing';

/** GET /api/publish-posts?view=queue|history&cursor (session): posts the user may see, newest first. */
export const GET = handleApi(async ({ req, user }) => {
  const view = req.nextUrl.searchParams.get('view') === 'history' ? 'history' : 'queue';
  const cursor = req.nextUrl.searchParams.get('cursor');
  return listPublishPosts(view, user, cursor && !Number.isNaN(Date.parse(cursor)) ? cursor : null);
});

/** POST /api/publish-posts (session): creates draft posts (1–5 videos). Nothing is sent until the owner approves. */
export const POST = handleApi(async ({ req, user }) => createPublishPosts(await parseJson(req, CreatePublishPostsSchema), user));
