import { z } from 'zod';
import { handleApi, parseJson } from '@/lib/api';
import { changePassword } from '@/lib/auth';

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password').max(256),
  newPassword: z.string().min(1, 'Enter a new password').max(256),
});

/** POST /api/auth/change-password — verifies the current password, stores the new one, signs out other devices. */
export const POST = handleApi(async ({ req, user, session }) => {
  const body = await parseJson(req, ChangePasswordSchema);
  const result = await changePassword(user.id, session.sessionId, body.currentPassword, body.newPassword);
  return { ok: true, ...result };
});
