import { z } from 'zod';
import { AppError } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { setDirectPublishing, setDraftsEnabled } from '@/lib/publishing';

const Body = z.object({ directPublishEnabled: z.boolean().optional(), draftsEnabled: z.boolean().optional() }).strict();

/**
 * PATCH /api/social-accounts/[id] (owner): the direct-publishing switch, and for a TikTok account behind Zernio the
 * "Send to TikTok drafts" switch. Each is refused (409) until its own verification post was confirmed.
 */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, Body);
  if (body.directPublishEnabled === undefined && body.draftsEnabled === undefined) throw new AppError('VALIDATION', 'Nothing to change.');
  let result = body.directPublishEnabled !== undefined ? await setDirectPublishing(params.id, body.directPublishEnabled, user) : null;
  if (body.draftsEnabled !== undefined) result = await setDraftsEnabled(params.id, body.draftsEnabled, user);
  return result;
});
