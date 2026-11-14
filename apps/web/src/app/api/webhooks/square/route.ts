import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@studio/db';
import { handlePublicApi } from '@/lib/api';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { getLogger } from '@/lib/logger';
import { SQUARE_SIGNATURE_HEADER, squareNotificationUrl, squareWebhookEnvelope, verifySquareSignature } from '@/lib/square/webhook';
import { readRawBody, storeWebhookEvent } from '@/lib/webhooks';

/**
 * POST /api/webhooks/square (public, no session, no CSRF; design §7.3). The HMAC is checked on the raw body and the
 * exact registered address before anything is parsed. A bad signature is refused and NOT stored (a forged event id
 * could otherwise block the real one). A good delivery is stored once per Square event id and handed to
 * `webhook.process`, which only re-reads the object from Square. No Square call happens in the request.
 *
 * Only a minimal envelope is stored ({@link squareWebhookEnvelope}): the event id, type, merchant, time and the
 * object's type and id. Square's copy of the object (a customer's name, email, phone, address, notes; booking notes;
 * payment amounts) is never kept, because the worker re-reads the object from Square anyway.
 */
export const POST = handlePublicApi(
  async ({ req }) => {
    const env = getEnv();
    const key = env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    if (!key) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Square webhooks are not enabled.' } }, { status: 404 });
    const rawBody = await readRawBody(req);
    const ok = verifySquareSignature({ signatureKey: key, notificationUrl: squareNotificationUrl(env), rawBody, signature: req.headers.get(SQUARE_SIGNATURE_HEADER) });
    if (!ok) {
      getLogger().warn({ webhook: 'square' }, 'square webhook with an invalid signature refused');
      return NextResponse.json({ error: { code: 'UNAUTHORISED', message: 'Invalid signature.' } }, { status: 401 });
    }
    let event: { event_id?: unknown; type?: unknown; merchant_id?: unknown } & Record<string, unknown>;
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      return NextResponse.json({ error: { code: 'VALIDATION', message: 'The body is not JSON.' } }, { status: 400 });
    }
    if (typeof event.event_id !== 'string' || typeof event.type !== 'string' || typeof event.merchant_id !== 'string') {
      return NextResponse.json({ error: { code: 'VALIDATION', message: 'event_id, type and merchant_id are required.' } }, { status: 400 });
    }
    const stored = await storeWebhookEvent({ provider: 'square', externalEventId: event.event_id, eventType: event.type, payload: squareWebhookEnvelope(event), signatureValid: true });
    const t = schema.integrationConnections;
    await getDb()
      .update(t)
      .set({ config: sql`${t.config} || ${JSON.stringify({ lastWebhookAt: new Date().toISOString() })}::jsonb` })
      .where(eq(t.provider, 'square'));
    return { ok: true, duplicate: !stored.stored };
  },
  { csrf: false },
);
