import { z } from 'zod';
import { SQUARE_SELLER_NOTE_MAX } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { requestBookingChange } from '@/lib/square/changes';

const id = z.string().min(1).max(64);
const instant = z.string().datetime({ offset: true });

const BodySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('create'),
      customerId: id,
      serviceVariationId: z.string().min(1).max(192),
      teamMemberId: z.string().min(1).max(192),
      startAt: instant,
      availabilitySearchId: id,
      sellerNote: z.string().max(SQUARE_SELLER_NOTE_MAX).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('reschedule'), bookingId: id, startAt: instant, teamMemberId: z.string().min(1).max(192), availabilitySearchId: id, expectedVersion: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('cancel'), bookingId: id, expectedVersion: z.number().int().min(0) }).strict(),
]);

/**
 * POST /api/appointments/changes (owner): records one owner-approved booking change (create, move or cancel) and
 * queues `square.booking_change`, which re-checks everything with Square just before the one write. Refused with a
 * plain reason (422) while booking changes are not available, switched off or paused, for a service not confirmed
 * free of no-show fees, a slot not in a search at most 5 minutes old, or a booking that is not accepted and in the
 * future; 409 when the booking changed in Square since it was opened. Returns `{ change, jobId }` to poll.
 */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, BodySchema);
  return requestBookingChange(body, user);
});
