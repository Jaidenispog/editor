import { AUTOMATION_NAMES, AppError, UpdateAutomationSchema, type AutomationName } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { updateAutomation } from '@/lib/email';

/** PUT /api/email/automations/[name] (owner): `follow_up` or `review_request`; 422 when switching on is blocked. */
export const PUT = handleApi<{ name: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  if (!(AUTOMATION_NAMES as readonly string[]).includes(params.name)) throw new AppError('NOT_FOUND', 'There is no such automation.');
  return updateAutomation(user, params.name as AutomationName, await parseJson(req, UpdateAutomationSchema));
});
