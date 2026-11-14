import { handleApi } from '@/lib/api';
import { requestExport } from '@/lib/studio-edits';

/** POST /api/edit-versions/[id]/export — queues the full-quality render (idempotent while queued or rendering). */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => Response.json(await requestExport(params.id, user), { status: 202 }));
