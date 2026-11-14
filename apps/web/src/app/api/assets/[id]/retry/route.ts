import { handleApi } from '@/lib/api';
import { retryAsset } from '@/lib/assets';

/** POST /api/assets/[id]/retry — re-queues analysis for a clip that failed. */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => Response.json(await retryAsset(params.id, user), { status: 202 }));
