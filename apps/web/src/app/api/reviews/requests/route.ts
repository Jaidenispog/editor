import { CreateReviewRequestSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { createManualReviewRequest, listReviewRequests } from '@/lib/reviews';

/** GET /api/reviews/requests (owner): requests and this month's counts (requests are never matched to reviews). */
export const GET = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return listReviewRequests(req.nextUrl.searchParams.get('status') ?? undefined);
});

/** POST /api/reviews/requests (owner): "Send a request" with the owner's confirmation that the visit went ahead. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, CreateReviewRequestSchema);
  return createManualReviewRequest(user, { customerId: body.customerId, visitDate: body.visitDate });
});
