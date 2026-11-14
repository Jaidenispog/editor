import { handleApi } from '@/lib/api';
import { listUserSessions } from '@/lib/auth';

/** GET /api/auth/sessions — the signed-in user's active sessions (the current one is flagged). */
export const GET = handleApi(async ({ user, session }) => {
  const sessions = await listUserSessions(user.id);
  return { sessions: sessions.map((s) => ({ ...s, current: s.id === session.sessionId })) };
});
