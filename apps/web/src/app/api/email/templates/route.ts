import { CreateTemplateSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { createTemplate, listTemplates } from '@/lib/email';

/** GET /api/email/templates (owner): templates (the built-in neutral ones are seeded on first call). */
export const GET = handleApi(async ({ user }) => {
  requireOwner(user);
  return listTemplates();
});

/** POST /api/email/templates (owner): a new template; 400 when the linter finds errors. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return createTemplate(user, await parseJson(req, CreateTemplateSchema));
});
