import { handleApi } from '@/lib/api';
import { getIntegrationStatuses } from '@/lib/integrations';

/** GET /api/integrations/status — each integration with { configured, connected, message, missingEnv }. No secret values. */
export const GET = handleApi(async () => ({ integrations: await getIntegrationStatuses() }));
