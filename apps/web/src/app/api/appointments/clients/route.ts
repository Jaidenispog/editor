import { z } from 'zod';
import { handleApi } from '@/lib/api';
import { listClients } from '@/lib/square/appointments';

const QuerySchema = z.object({ q: z.string().max(100).optional(), cursor: z.string().regex(/^\d{1,6}$/).optional() });

/** GET /api/appointments/clients?q&cursor (signed in): clients copied from Square; email and phone only for the owner. */
export const GET = handleApi(async ({ req, user }) => listClients(QuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams)), user));
