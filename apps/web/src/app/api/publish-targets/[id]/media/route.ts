import { handleApi } from '@/lib/api';
import { targetMedia } from '@/lib/publishing';

/** GET /api/publish-targets/[id]/media (session): expiring links to the exact file, the cover and the caption. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => targetMedia(params.id, user));
