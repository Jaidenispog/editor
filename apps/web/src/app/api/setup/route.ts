import { z } from 'zod';
import { handlePublicApi, parseJson } from '@/lib/api';
import { createOwnerAccount, createSession, requestMetaFromHeaders } from '@/lib/auth';
import { setSessionCookie } from '@/lib/session';
import { getSettings } from '@/lib/settings';

const SetupSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(200),
  password: z.string().min(1, 'Choose a password').max(256),
  displayName: z.string().trim().min(1, 'Enter your name').max(80),
});

/** POST /api/setup — first run only: creates the owner account and signs them in. */
export const POST = handlePublicApi(async ({ req }) => {
  const body = await parseJson(req, SetupSchema);
  const user = await createOwnerAccount(body);
  await getSettings();
  const session = await createSession(user.id, requestMetaFromHeaders(req.headers));
  await setSessionCookie(session.token, session.expiresAt);
  return { user };
});
