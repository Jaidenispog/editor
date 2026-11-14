import { z } from 'zod';
import { handlePublicApi, parseJson } from '@/lib/api';
import { authenticate, createSession, requestMetaFromHeaders } from '@/lib/auth';
import { setSessionCookie } from '@/lib/session';

const LoginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address').max(200),
  password: z.string().min(1, 'Enter your password').max(256),
});

/** POST /api/auth/login — checks credentials (rate limited) and sets the sa_session cookie. */
export const POST = handlePublicApi(async ({ req }) => {
  const body = await parseJson(req, LoginSchema);
  const meta = requestMetaFromHeaders(req.headers);
  const user = await authenticate(body.email, body.password, meta);
  const session = await createSession(user.id, meta);
  await setSessionCookie(session.token, session.expiresAt);
  return { user };
});
