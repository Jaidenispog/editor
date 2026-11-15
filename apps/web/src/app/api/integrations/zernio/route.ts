import { ZernioConnectSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { connectZernio, disconnectZernio, getZernioConnection } from '@/lib/publishing';

/** GET /api/integrations/zernio (session): the optional TikTok route through Zernio, for Settings. Never the key. */
export const GET = handleApi(async ({ user }) => getZernioConnection(user));

/** POST /api/integrations/zernio (owner, flag on): saves the API key encrypted and runs the read-only check. */
export const POST = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, ZernioConnectSchema);
  return connectZernio(body.apiKey, user);
});

/** DELETE /api/integrations/zernio (owner): forgets the key; unsent Zernio destinations wait for a reconnect. */
export const DELETE = handleApi(async ({ user }) => disconnectZernio(user));
