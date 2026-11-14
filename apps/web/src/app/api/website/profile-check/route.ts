import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { setProfileCheck } from '@/lib/website';

/** PUT /api/website/profile-check (owner) `{ checked }`: the manual Business Profile details check (no API call). */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, z.object({ checked: z.boolean() }));
  return setProfileCheck(body.checked);
});
