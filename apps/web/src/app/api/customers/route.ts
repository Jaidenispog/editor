import { CreateCustomerSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { createClient, listClients } from '@/lib/email';

/** GET /api/customers (staff and owner): clients with their email permission. */
export const GET = handleApi(async ({ req }) => {
  const q = req.nextUrl.searchParams;
  return listClients({ q: q.get('q') ?? undefined, permission: q.get('permission') ?? undefined });
});

/** POST /api/customers (owner): a manual client (no Square); 409 when the address matches an existing client. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  return createClient(user, await parseJson(req, CreateCustomerSchema));
});
