import { CreateEmailMessageSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { createDraft, listMessages } from '@/lib/email';

/** GET /api/email/messages (owner): drafts, approvals and the send log, newest first. No token data. */
export const GET = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const q = req.nextUrl.searchParams;
  const pick = (k: string) => q.get(k) ?? undefined;
  return listMessages({ status: pick('status'), origin: pick('origin'), purpose: pick('purpose'), customerId: pick('customerId'), campaignId: pick('campaignId'), view: pick('view') });
});

/** POST /api/email/messages (owner): a one-off draft to a client (information only or marketing). */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return createDraft(user, await parseJson(req, CreateEmailMessageSchema));
});
