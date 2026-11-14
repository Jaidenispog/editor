import { handleApi, requireOwner } from '@/lib/api';
import { withdrawBookingChange } from '@/lib/square/changes';

/**
 * POST /api/appointments/changes/[id]/cancel (owner): withdraws a change that has not started yet (`queued` →
 * `cancelled`). 409 once Studio Assistant has started checking it: it then finishes.
 */
export const POST = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return withdrawBookingChange(params.id, user);
});
