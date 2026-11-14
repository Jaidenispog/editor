import { NextResponse } from 'next/server';
import { AppError } from '@studio/core';
import { handlePublicApi } from '@/lib/api';
import { checkPostmarkBasicAuth, postmarkExternalEventId } from '@/lib/email';
import { getEnv } from '@/lib/env';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';
import { readRawBody, storeWebhookEvent } from '@/lib/webhooks';

/**
 * POST /api/webhooks/postmark (public, no CSRF): Postmark delivery, bounce, spam-complaint and subscription-change
 * webhooks (design §8.1.5). HTTP Basic credentials are checked in constant time before anything is stored; a wrong or
 * missing one gets 401 and nothing is stored. Each delivery is stored once and processed by the worker, where it may
 * only restrict sending or update delivery display.
 */
export const POST = handlePublicApi(
  async ({ req }) => {
    enforcePublicRateLimit(req, 'webhook');
    const env = getEnv();
    const auth = checkPostmarkBasicAuth(req.headers.get('authorization'), env);
    if (auth === 'not_configured') throw new AppError('INTEGRATION_NOT_CONFIGURED', 'Postmark webhooks are not set up on this server.', { status: 503 });
    if (auth === 'bad') return NextResponse.json({ error: { code: 'UNAUTHORISED', message: 'Wrong webhook credentials.' } }, { status: 401, headers: { 'www-authenticate': 'Basic realm="postmark"' } });
    const raw = await readRawBody(req);
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      record = parsed as Record<string, unknown>;
    } catch {
      throw new AppError('VALIDATION', 'The webhook body was not a JSON object.');
    }
    const { id, type } = postmarkExternalEventId(raw, record);
    const result = await storeWebhookEvent({ provider: 'postmark', externalEventId: id, eventType: type, payload: record, signatureValid: true });
    return { received: true, duplicate: !result.stored };
  },
  { csrf: false },
);
