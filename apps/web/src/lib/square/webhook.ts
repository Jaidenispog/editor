import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '@studio/config';

/** Square's signature header. */
export const SQUARE_SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

/**
 * The notification address Square signs with. It must be byte-identical to the address registered in the
 * Developer Console (a trailing slash matters), so an explicit SQUARE_WEBHOOK_NOTIFICATION_URL wins.
 */
export function squareNotificationUrl(env: Pick<Env, 'APP_URL' | 'SQUARE_WEBHOOK_NOTIFICATION_URL'>): string {
  return env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? `${env.APP_URL.replace(/\/+$/, '')}/api/webhooks/square`;
}

/** base64(HMAC-SHA256(signature key, notification URL + raw body)), Square's documented algorithm. */
export function squareSignature(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return createHmac('sha256', signatureKey).update(notificationUrl + rawBody, 'utf8').digest('base64');
}

/**
 * Checks Square's signature on the raw body with a constant-time comparison (Square's SDK helper compares with `===`
 * and its README forgets the `await`, so the algorithm is implemented here). A missing or wrong-length signature is
 * false, never an exception.
 */
export function verifySquareSignature(input: { signatureKey: string; notificationUrl: string; rawBody: string; signature: string | null }): boolean {
  if (!input.signature) return false;
  const expected = Buffer.from(squareSignature(input.signatureKey, input.notificationUrl, input.rawBody), 'utf8');
  const given = Buffer.from(input.signature.trim(), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The only part of a verified Square delivery that is stored: what `webhook.process` needs to re-read the object from
 * Square (event id, type, merchant, time, and the object's type and id). Square's copy of the object, which can hold
 * a client's name, contact details, address and notes, is dropped before anything is written.
 */
export function squareWebhookEnvelope(event: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
  const data = event['data'] && typeof event['data'] === 'object' ? (event['data'] as Record<string, unknown>) : {};
  return {
    event_id: str(event['event_id'], 200),
    type: str(event['type'], 100),
    merchant_id: str(event['merchant_id'], 200),
    created_at: str(event['created_at'], 40),
    data: { type: str(data['type'], 100), id: str(data['id'], 192) },
  };
}
