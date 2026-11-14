import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { requestSelfTest } from '@/lib/square/changes';

const BodySchema = z
  .object({
    customerId: z.string().min(1).max(64),
    serviceVariationId: z.string().min(1).max(192),
    teamMemberId: z.string().min(1).max(192),
    startAt: z.string().datetime({ offset: true }),
    availabilitySearchId: z.string().min(1).max(64),
    acknowledgeLive: z.boolean(),
  })
  .strict();

/**
 * POST /api/integrations/square/self-test (owner): starts the booking-changes self-test, which makes three real
 * changes in Square (book, move by one free slot, cancel). Never run automatically. Refused (422) until checklist
 * lines 1–3 are ticked and while booking changes are not available; 409 while a test runs; 400 on live Square
 * without the acknowledgement, for a slot not in a fresh search, or one less than 48 hours ahead.
 */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, BodySchema);
  return requestSelfTest(body, user);
});
