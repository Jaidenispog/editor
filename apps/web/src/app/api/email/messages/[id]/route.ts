import { UpdateEmailMessageSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { messageDetail, updateDraft } from '@/lib/email';

/** GET /api/email/messages/[id] (owner): the message, its rendered copy, timeline, consent basis and blockers. */
export const GET = handleApi<{ id: string }>(async ({ params, user }) => {
  requireOwner(user);
  return messageDetail(params.id);
});

/** PATCH /api/email/messages/[id] (owner): edits a draft. */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return updateDraft(user, params.id, await parseJson(req, UpdateEmailMessageSchema));
});
