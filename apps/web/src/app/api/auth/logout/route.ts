import { handlePublicApi } from '@/lib/api';
import { destroySession } from '@/lib/auth';
import { writeAudit } from '@/lib/audit';
import { clearSessionCookie, getCurrentSession, getSessionToken } from '@/lib/session';

/** POST /api/auth/logout — deletes the session and clears the cookie (works even if the session already expired). */
export const POST = handlePublicApi(async () => {
  const session = await getCurrentSession();
  await destroySession(await getSessionToken());
  await clearSessionCookie();
  if (session) await writeAudit({ userId: session.user.id, action: 'auth.logout', entityType: 'user', entityId: session.user.id });
  return { ok: true };
});
