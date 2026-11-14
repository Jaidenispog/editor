import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { LearningToggleSchema, setLearningEnabled } from '@/lib/preferences';

/** POST /api/preferences/learning — { enabled }: "Learn from my choices" on or off (owner only). */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const { enabled } = await parseJson(req, LearningToggleSchema);
  return { preferences: await setLearningEnabled(user, enabled) };
});
