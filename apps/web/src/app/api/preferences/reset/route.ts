import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { ResetLearningSchema, resetLearning } from '@/lib/preferences';

/** POST /api/preferences/reset — { confirm: true }: forget what was learned before now; own settings stay (owner only). */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  await parseJson(req, ResetLearningSchema);
  return { preferences: await resetLearning(user) };
});
