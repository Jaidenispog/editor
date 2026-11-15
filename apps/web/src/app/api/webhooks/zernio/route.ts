import { NextResponse } from 'next/server';
import { handlePublicApi } from '@/lib/api';
import { getLogger } from '@/lib/logger';
import { ZERNIO_SIGNATURE_HEADER, receiveZernioWebhook, zernioOn } from '@/lib/publishing';
import { readRawBody } from '@/lib/webhooks';

/**
 * POST /api/webhooks/zernio (public, no session, no CSRF; design §7.2.5). Reads the raw body (256 KB at most),
 * checks `X-Zernio-Signature` (hex HMAC-SHA256 of the raw body) when ZERNIO_WEBHOOK_SECRET is set, stores an envelope
 * once (under the event id only when verified, otherwise under `unverified:<sha256>`), queues `webhook.process`, and
 * answers JSON 200 at once. A badly signed delivery is still answered 200 and stored as unverified: deliveries are
 * only hints that trigger a read with our own key, so a forged one can at most cause an extra read. Nothing calls
 * Zernio in the request.
 */
export const POST = handlePublicApi(
  async ({ req }) => {
    if (!zernioOn()) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Zernio webhooks are not enabled.' } }, { status: 404 });
    const rawBody = await readRawBody(req);
    try {
      const result = await receiveZernioWebhook(rawBody, req.headers.get(ZERNIO_SIGNATURE_HEADER));
      return { ok: true, duplicate: !result.stored };
    } catch (err) {
      getLogger().warn({ webhook: 'zernio', err: err instanceof Error ? err.message : String(err) }, 'zernio webhook not stored');
      throw err;
    }
  },
  { csrf: false },
);
