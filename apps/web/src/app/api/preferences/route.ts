import { handleApi } from '@/lib/api';
import { getPreferencesView } from '@/lib/preferences';

/** GET /api/preferences — declared, effective and learned preferences with sources, evidence and recent choices (staff read-only). */
export const GET = handleApi(async ({ user }) => getPreferencesView(user));
