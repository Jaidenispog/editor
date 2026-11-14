import { handleApi } from '@/lib/api';
import { abortUpload, getUpload } from '@/lib/uploads';

/** GET /api/uploads/[id] — which parts have arrived, for resuming after a page reload. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => getUpload(params.id, user));

/** DELETE /api/uploads/[id] — cancels an unfinished upload and removes its staged parts. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user }) => {
  await abortUpload(params.id, user);
  return undefined;
});
