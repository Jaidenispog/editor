import { handleApi } from '@/lib/api';
import { getPublishingConnections } from '@/lib/publishing';

/** GET /api/publishing/connections (session): the Instagram connection's state (never its token) and the handles. */
export const GET = handleApi(async ({ user }) => getPublishingConnections(user));
