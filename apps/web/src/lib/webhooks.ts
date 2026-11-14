import 'server-only';
import { eq } from 'drizzle-orm';
import { AppError, newId } from '@studio/core';
import { schema } from '@studio/db';
import { getDb } from './db.js';
import { createTrackedJob } from './jobs.js';
import { getLogger } from './logger.js';

/** Largest webhook body accepted (providers send far less). */
export const WEBHOOK_MAX_BYTES = 256 * 1024;

/**
 * Reads the raw request body (needed for signature checks) without trusting Content-Length, stopping at `maxBytes`.
 * A larger body is refused with 413 before it is fully read.
 */
export async function readRawBody(req: Request, maxBytes: number = WEBHOOK_MAX_BYTES): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('VALIDATION', 'The webhook body is too large.', { status: 413 });
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError('VALIDATION', 'The webhook body is too large.', { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One verified (or knowingly unverified) delivery to store. */
export interface WebhookEventInput {
  /** Matches the module's worker webhook handler key, e.g. `square`, `postmark`, `zernio`. */
  provider: string;
  /** The provider's event id, or `unverified:<sha256(body)>` for a delivery whose signature could not be checked. */
  externalEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signatureValid: boolean;
}

/**
 * Stores a delivery once per (provider, external event id) with `ON CONFLICT DO NOTHING`, and queues
 * `webhook.process` only when this call inserted the row, so a redelivered event gives one row and one job.
 * Verification is the caller's job and happens before this (an invalid Square or Postmark delivery is never stored).
 */
export async function storeWebhookEvent(input: WebhookEventInput): Promise<{ stored: boolean; webhookEventId: string | null }> {
  const id = newId();
  const inserted = await getDb()
    .insert(schema.webhookEvents)
    .values({ id, provider: input.provider, externalEventId: input.externalEventId.slice(0, 300), eventType: input.eventType.slice(0, 120), payload: input.payload, signatureValid: input.signatureValid })
    .onConflictDoNothing({ target: [schema.webhookEvents.provider, schema.webhookEvents.externalEventId] })
    .returning({ id: schema.webhookEvents.id });
  if (!inserted.length) return { stored: false, webhookEventId: null };
  try {
    await createTrackedJob({ type: 'webhook.process', payload: { webhookEventId: id }, projectId: null, singletonKey: `webhook:${id}` });
  } catch (err) {
    // Without a job nobody would process the row, so remove it and fail the request: the provider delivers again
    // later and that delivery is stored fresh.
    getLogger().error({ err, provider: input.provider, webhookEventId: id }, 'could not queue webhook processing');
    await getDb().delete(schema.webhookEvents).where(eq(schema.webhookEvents.id, id));
    throw err;
  }
  return { stored: true, webhookEventId: id };
}
