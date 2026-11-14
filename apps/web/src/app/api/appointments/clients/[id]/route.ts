import { handleApi } from '@/lib/api';
import { getClient } from '@/lib/square/appointments';

/** GET /api/appointments/clients/[id] (signed in): one client and their bookings. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => getClient(params.id, user));
