import { handleApi } from '@/lib/api';
import { listenLink } from '@/lib/music';

/** GET /api/music/[id]/listen — { url, expiresInSeconds, mimeType }: an expiring link to the track's audio. */
export const GET = handleApi<{ id: string }>(async ({ params }) => listenLink(params.id));
