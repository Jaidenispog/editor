import { handleApi } from '@/lib/api';
import { getBookingDetail } from '@/lib/square/appointments';

/** GET /api/appointments/[id] (signed in): one booking with its attendance evidence and the "Open in Square" link. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => getBookingDetail(params.id, user));
