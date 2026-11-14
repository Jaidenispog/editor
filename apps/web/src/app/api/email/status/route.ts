import { handleApi } from '@/lib/api';
import { getEmailStatus } from '@/lib/email';

/** GET /api/email/status (staff and owner): the provider's state from the last read-only check. */
export const GET = handleApi(async () => getEmailStatus());
