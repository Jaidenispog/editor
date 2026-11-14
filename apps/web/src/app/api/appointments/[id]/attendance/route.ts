import { z } from 'zod';
import { handleApi, parseJson } from '@/lib/api';
import { markAttendance } from '@/lib/square/appointments';

const BodySchema = z.object({ value: z.enum(['attended', 'not_attended']).nullable() }).strict();

/**
 * POST /api/appointments/[id]/attendance (owner or staff) `{ value: 'attended' | 'not_attended' | null }`: the
 * person's own mark (also the email module's "Mark as completed" / "Didn't happen"). 409 when Square's status is a
 * no-show, cancellation or decline, or the appointment has not started. Never written to Square.
 */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, BodySchema);
  return markAttendance(params.id, body.value, user);
});
