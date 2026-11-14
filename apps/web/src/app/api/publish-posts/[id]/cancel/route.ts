import { handleApi } from '@/lib/api';
import { cancelPublishPost } from '@/lib/publishing';

/** POST /api/publish-posts/[id]/cancel (owner): cancels every destination not yet sent. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => cancelPublishPost(params.id, user));
