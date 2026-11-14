import { NextResponse, type NextRequest } from 'next/server';
import { escapeHtml } from '@studio/core';
import { getLogger } from '@/lib/logger';
import { enforcePublicRateLimit } from '@/lib/public-rate-limit';
import { recordReviewClick } from '@/lib/reviews';

/**
 * GET /r/[token] (public): the tracked review link. Counts the open when the token is known (email security scanners
 * may open it too), then always redirects to the same saved review link: every token, valid or not, goes to the same
 * place, so nothing branches on who clicked (memo §7). Without a saved link it shows a plain page instead.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await context.params;
  try {
    enforcePublicRateLimit(req, 'link');
  } catch {
    return new NextResponse('Too many requests. Please wait a minute and try again.', { status: 429, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  try {
    const { url, businessName } = await recordReviewClick(token);
    if (url) return NextResponse.redirect(url, { status: 302, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
    const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(businessName)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1f1f1f"><p>Search for <strong>${escapeHtml(businessName)}</strong> on Google Maps to leave a review.</p></body></html>`;
    return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  } catch (err) {
    getLogger().error({ err }, 'review link redirect failed');
    return new NextResponse('Something went wrong. Please try the link again later.', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
