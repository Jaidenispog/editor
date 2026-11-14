import { ResolveTargetSchema } from '@studio/core';
import { handleApi, parseJson } from '@/lib/api';
import { resolveTarget } from '@/lib/publishing';

/** POST /api/publish-targets/[id]/resolve (owner): post without music, post it yourself, send again after checking, or mark posted. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, ResolveTargetSchema);
  return resolveTarget(params.id, body.action, user);
});
