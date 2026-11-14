import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { getSettings, updateSettings } from '@/lib/settings';
import { SettingsPatchSchema } from '@/lib/settings-merge';

/** GET /api/settings — brand, business details and editing preferences. */
export const GET = handleApi(async () => ({ settings: await getSettings() }));

/** PUT /api/settings — partial update (owner only); returns the merged, validated settings. */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const patch = await parseJson(req, SettingsPatchSchema);
  return { settings: await updateSettings(patch, user.id) };
});
