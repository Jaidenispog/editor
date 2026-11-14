import { UpdateCustomerSchema } from '@studio/core';
import { handleApi, parseJson, requireOwner } from '@/lib/api';
import { updateClient } from '@/lib/email';

/** PATCH /api/customers/[id] (owner): manual clients only (Square clients are edited in Square). */
export const PATCH = handleApi<{ id: string }>(async ({ req, params, user }) => {
  requireOwner(user);
  return updateClient(user, params.id, await parseJson(req, UpdateCustomerSchema));
});
