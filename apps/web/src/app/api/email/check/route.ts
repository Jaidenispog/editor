import { handleApi, requireOwner } from '@/lib/api';
import { requestProviderCheck } from '@/lib/email';

/** POST /api/email/check (owner): queues the read-only Postmark check. No email is sent. */
export const POST = handleApi(async ({ user }) => {
  requireOwner(user);
  return requestProviderCheck(user);
});
