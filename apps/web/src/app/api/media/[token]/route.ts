import { Readable } from 'node:stream';
import { AppError } from '@studio/core';
import { contentTypeForKey, verifyMediaLink } from '@studio/storage';
import { handlePublicApi } from '@/lib/api';
import { getEnv } from '@/lib/env';
import { contentDispositionAttachment, parseRangeHeader } from '@/lib/http-range';
import { getLocalDiskStore } from '@/lib/storage';

/**
 * GET /api/media/[token] — streams a stored file for the local storage driver after verifying the HMAC-signed,
 * expiring token. Supports HTTP Range requests (206) so video players can seek. With the S3 driver links are
 * presigned by the bucket, so this route answers 404.
 */
export const GET = handlePublicApi<{ token: string }>(
  async ({ req, params }) => {
    const store = getLocalDiskStore();
    if (!store) throw new AppError('NOT_FOUND', 'This link is not served by the app.');
    const claims = verifyMediaLink(params.token, getEnv().APP_SECRET);
    if (!claims) throw new AppError('NOT_FOUND', 'This link has expired or is not valid. Refresh the page to get a new one.');
    const stat = await store.stat(claims.key);
    if (!stat) throw new AppError('NOT_FOUND', 'This file is no longer available.');

    const size = stat.size;
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type': claims.contentType ?? contentTypeForKey(claims.key),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    if (claims.downloadName) headers.set('Content-Disposition', contentDispositionAttachment(claims.downloadName));
    if (stat.lastModified) headers.set('Last-Modified', stat.lastModified.toUTCString());

    const range = parseRangeHeader(req.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (req.method === 'HEAD') {
      headers.set('Content-Length', String(size));
      return new Response(null, { status: 200, headers });
    }
    const nodeStream = await store.getStream(claims.key, range ? { start: range.start, end: range.end } : undefined);
    req.signal.addEventListener('abort', () => nodeStream.destroy(), { once: true });
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      return new Response(body, { status: 206, headers });
    }
    headers.set('Content-Length', String(size));
    return new Response(body, { status: 200, headers });
  },
  { csrf: false },
);

/** HEAD /api/media/[token] — same checks as GET without the body. */
export const HEAD = GET;
