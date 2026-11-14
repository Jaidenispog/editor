import { AppError, RecordUnsubscribeSchema } from '@studio/core';
import { schema } from '@studio/db';
import { eq } from 'drizzle-orm';
import { handleApi, parseJson } from '@/lib/api';
import { getDb } from '@/lib/db';
import { consentDetail, recordUnsubscribe } from '@/lib/email';

/** POST /api/customers/[id]/unsubscribe (staff and owner): records an unsubscribe given in person, by phone or by reply. */
export const POST = handleApi<{ id: string }>(async ({ req, params, user }) => {
  const body = await parseJson(req, RecordUnsubscribeSchema);
  const customer = await getDb().query.customers.findFirst({ where: eq(schema.customers.id, params.id) });
  if (!customer) throw new AppError('NOT_FOUND', 'That client no longer exists.');
  if (!customer.email) throw new AppError('VALIDATION', 'This client has no email address.');
  await recordUnsubscribe({ email: customer.email, customerId: customer.id, method: body.method, recordedBy: user.id, note: body.note });
  return { state: (await consentDetail(customer.id)).state };
});
