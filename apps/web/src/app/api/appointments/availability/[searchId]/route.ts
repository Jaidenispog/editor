import { handleApi } from '@/lib/api';
import { getAvailabilitySearch } from '@/lib/square/appointments';

/** GET /api/appointments/availability/[searchId] (signed in): the search's state and free times in Melbourne time. */
export const GET = handleApi<{ searchId: string }>(async ({ params }) => getAvailabilitySearch(params.searchId));
