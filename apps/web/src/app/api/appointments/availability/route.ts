import { z } from 'zod';
import { handleApi, parseJson } from '@/lib/api';
import { createAvailabilitySearch } from '@/lib/square/appointments';

const BodySchema = z
  .object({
    serviceVariationId: z.string().min(1).max(192),
    teamMemberId: z.string().min(1).max(192).nullable().optional(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a start date.'),
    days: z.number().int().min(1).max(14),
  })
  .strict();

/**
 * POST /api/appointments/availability (signed in): starts a read-only free-times search in Square for a service
 * (optionally one barber) over 1–14 Melbourne days. Returns the search id to poll.
 */
export const POST = handleApi(async ({ req, user }) => createAvailabilitySearch(await parseJson(req, BodySchema), user));
