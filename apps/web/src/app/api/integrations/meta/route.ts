import { handleApi } from '@/lib/api';
import { disconnectMeta } from '@/lib/publishing';

/** DELETE /api/integrations/meta (owner): disconnects Instagram direct publishing (the stored token is wiped). */
export const DELETE = handleApi(async ({ user }) => disconnectMeta(user));
