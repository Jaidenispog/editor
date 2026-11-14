import { z } from 'zod';
import { handleApi } from '@/lib/api';
import { listBookings } from '@/lib/square/appointments';

const QuerySchema = z.object({
  view: z.enum(['upcoming', 'confirm', 'past']).default('upcoming'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  days: z.coerce.number().int().min(1).max(62).optional(),
  cursor: z.string().regex(/^\d{1,6}$/).optional(),
});

/**
 * GET /api/appointments?view=upcoming|confirm|past&from=YYYY-MM-DD&days=1..62&cursor (signed in): bookings from
 * Studio Assistant's copy of Square (Square is never called in a request).
 */
export const GET = handleApi(async ({ req }) => {
  const q = QuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return listBookings(q);
});
