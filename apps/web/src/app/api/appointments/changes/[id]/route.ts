import { handleApi } from '@/lib/api';
import { getBookingChange } from '@/lib/square/changes';

/** GET /api/appointments/changes/[id] (signed in): one booking change and where it is up to (polled every second). */
export const GET = handleApi<{ id: string }>(async ({ params }) => getBookingChange(params.id));
