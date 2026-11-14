import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { PinPreferenceSchema, pinPreference } from '@/lib/preferences';

/** POST /api/preferences/pin — { field, pinned, value? }: pin a field (to a value or the value in use) or let it learn (owner only). */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, PinPreferenceSchema);
  return { preferences: await pinPreference(user, body) };
});
