import { UpdateTemplateSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { updateTemplate } from '@/lib/email';

/** PATCH /api/email/templates/[id] (owner): edit or archive (`enabled: false`); templates are never deleted. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return updateTemplate(user, params.id, await parseJson(req, UpdateTemplateSchema));
});
