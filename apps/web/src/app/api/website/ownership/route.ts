import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { confirmOwnership } from '@/lib/website';

/** POST /api/website/ownership (owner) `{ confirm: true }`: "This is my business's own website" for the saved host. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  await parseJson(req, z.object({ confirm: z.literal(true) }));
  return confirmOwnership(user);
});
