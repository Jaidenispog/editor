import { UpdateEmailSettingsSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { updateEmailSettings } from '@/lib/email';

/** PUT /api/email/settings (owner): sender name, reply-to, consent wording, window, daily limit, Square's messages. */
export const PUT = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return updateEmailSettings(user, await parseJson(req, UpdateEmailSettingsSchema));
});
