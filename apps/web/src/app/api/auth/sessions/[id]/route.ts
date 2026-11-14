import { AppError } from '@studio/core';
import { handleApi } from '@/lib/api';
import { destroySessionById } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';

/** DELETE /api/auth/sessions/[id] — signs out one of your other devices. */
export const DELETE = handleApi<{ id: string }>(async ({ params, user, session }) => {
  if (params.id === session.sessionId) {
    throw new AppError('CONFLICT', 'This is the device you are using now. Use “Sign out” instead.');
  }
  const removed = await destroySessionById(user.id, params.id);
  if (!removed) throw new AppError('NOT_FOUND', 'That session has already ended.');
  await writeAudit({ userId: user.id, action: 'auth.session_revoked', entityType: 'session', entityId: params.id.slice(0, 12) });
  return { ok: true };
});
