import { z } from 'zod';
import { handleApi, parseJson } from '@/lib/api';
import { setDirectPublishing } from '@/lib/publishing';

const Body = z.object({ directPublishEnabled: z.boolean() }).strict();

/** PATCH /api/social-accounts/[id] (owner): the direct-publishing switch (409 until a verification post was confirmed). */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, Body);
  return setDirectPublishing(params.id, body.directPublishEnabled, user);
});
