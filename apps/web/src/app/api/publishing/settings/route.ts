import { z } from 'zod';
import { PublishingSettingsSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { savePublishingSettings } from '@/lib/publishing';

const Body = z.object({ captionFooter: PublishingSettingsSchema.shape.captionFooter }).strict();

/** PUT /api/publishing/settings (owner): the default caption ending the composer prefills. */
export const PUT = handleApi(async ({ req, user }) => {
  const body = await parseJson(req, Body);
  return savePublishingSettings(body.captionFooter, user);
});
