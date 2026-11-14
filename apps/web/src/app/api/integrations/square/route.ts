import { z } from 'zod';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { disconnectSquare, getSquareStatus, updateSquareSettings } from '@/lib/square/status';

/** GET /api/integrations/square (signed in): the Square card's state (never tokens or secrets). */
export const GET = handleApi(async ({ user }) => getSquareStatus(user));

const PatchSchema = z
  .object({
    locationId: z.string().min(1).max(192).optional(),
    writesEnabled: z.boolean().optional(),
    serviceConfirmation: z.object({ variationId: z.string().min(1).max(192), confirmed: z.boolean() }).optional(),
  })
  .strict();

/**
 * PATCH /api/integrations/square (owner): choose the location, confirm a service has no no-show fee, or switch
 * booking changes off. Switching them on is refused until every checklist line is ticked (Tier 1 is not built yet).
 */
export const PATCH = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, PatchSchema);
  await updateSquareSettings(user, body);
  return getSquareStatus(user);
});

const DeleteSchema = z.object({ purgeData: z.boolean() }).strict();

/**
 * DELETE /api/integrations/square (owner) `{ purgeData }`: disconnects Square (tokens wiped, Square asked to revoke
 * access), optionally removing every copied booking and client. Bookings in Square are not affected.
 */
export const DELETE = handleApi(async ({ req, user }) => {
  requireOwner(user);
  const body = await parseJson(req, DeleteSchema);
  return disconnectSquare(user, body.purgeData);
});
