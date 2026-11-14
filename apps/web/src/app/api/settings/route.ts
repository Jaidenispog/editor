import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { updateSettingsFromPatch } from '@/lib/preferences';
import { getSettings } from '@/lib/settings';
import { SettingsPatchSchema } from '@/lib/settings-merge';

/** GET /api/settings — brand, business details and editing preferences. */
export const GET = handleApi(async () => ({ settings: await getSettings() }));

/**
 * PUT /api/settings — partial update (owner only); returns the merged, validated settings. Learning fields and the
 * Spotify mode are refused (they have their own routes); any learnable preference changed here is pinned to the owner.
 */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const patch = await parseJson(req, SettingsPatchSchema);
  return { settings: await updateSettingsFromPatch(patch, user.id) };
});
