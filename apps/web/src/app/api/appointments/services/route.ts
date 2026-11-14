import { handleApi } from '@/lib/api';
import { getSquareStatus } from '@/lib/square/status';

/** GET /api/appointments/services (signed in): Square services with their "can be booked from here" label, and the team. */
export const GET = handleApi(async ({ user }) => {
  const s = await getSquareStatus(user);
  return { services: s.services, teamMembers: s.teamMembers };
});
