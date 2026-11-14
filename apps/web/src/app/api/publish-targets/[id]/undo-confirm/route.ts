import { handleApi } from '@/lib/api';
import { undoConfirm } from '@/lib/publishing';

/** POST /api/publish-targets/[id]/undo-confirm (session): undoes a manual "I've posted it". */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => undoConfirm(params.id, user));
