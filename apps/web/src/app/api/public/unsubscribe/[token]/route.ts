import { NextResponse } from 'next/server';
import { handlePublicApi } from '@/lib/api';
import { unsubscribeByToken } from '@/lib/email';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';
import { readRawBody } from '@/lib/webhooks';

/**
 * POST /api/public/unsubscribe/[token] (public, no CSRF: it can only ever reduce sending). Accepts the unsubscribe
 * page's plain form post (works without JavaScript) and the RFC 8058 one-click body `List-Unsubscribe=One-Click`.
 * Looks the token up by its SHA-256, records the unsubscribe once (repeats change nothing), and answers 303 to the
 * page. An unknown token goes to the page's "isn't valid" message.
 */
export const POST = handlePublicApi<{ token: string }>(
  async ({ req, params }) => {
    enforcePublicRateLimit(req, 'link');
    const body = await readRawBody(req, 4096).catch(() => '');
    const oneClick = /(^|&)List-Unsubscribe=One-Click(&|$)/i.test(body.trim());
    const outcome = await unsubscribeByToken(params.token, oneClick ? 'one_click' : 'unsubscribe_page', req.headers.get('user-agent'));
    const target = new URL(`/u/${encodeURIComponent(params.token)}`, req.nextUrl.origin);
    target.searchParams.set(outcome === 'done' ? 'done' : 'invalid', '1');
    return NextResponse.redirect(target, 303);
  },
  { csrf: false },
);
