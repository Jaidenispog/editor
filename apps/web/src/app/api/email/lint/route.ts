import { LintRequestSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { lintAndPreview } from '@/lib/email';

/** POST /api/email/lint (owner): lint result and the exact preview, with no side effects. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return lintAndPreview(await parseJson(req, LintRequestSchema));
});
