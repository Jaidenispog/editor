import 'server-only';
import { getEnv } from './env.js';
import { getBlobStore } from './storage.js';

/**
 * Expiring link a browser can use for a stored file: an S3 presigned URL, or an HMAC-signed
 * /api/media/<token> link for the local driver. Valid for MEDIA_LINK_TTL_SECONDS.
 */
export async function signedUrlFor(key: string, options: { downloadName?: string; contentType?: string } = {}): Promise<string> {
  const env = getEnv();
  return getBlobStore().signedUrl(key, {
    expiresInSeconds: env.MEDIA_LINK_TTL_SECONDS,
    ...(options.downloadName ? { downloadName: options.downloadName } : {}),
    ...(options.contentType ? { contentType: options.contentType } : {}),
  });
}

/** Like signedUrlFor but returns null for a missing key or when signing fails (for optional thumbnails). */
export async function maybeSignedUrl(key: string | null | undefined, options: { downloadName?: string } = {}): Promise<string | null> {
  if (!key) return null;
  try {
    return await signedUrlFor(key, options);
  } catch {
    return null;
  }
}

/**
 * Makes a friendly, filesystem-safe download name such as "jordan-fade-beat-montage-v2.mp4".
 * Only letters, digits and dashes survive.
 */
export function downloadNameFor(parts: Array<string | number | null | undefined>, extension: string): string {
  const base = parts
    .filter((p): p is string | number => p !== null && p !== undefined && String(p).trim() !== '')
    .map((p) =>
      String(p)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('-')
    .slice(0, 80);
  return `${base || 'studio-assistant'}.${extension.replace(/^\./, '')}`;
}
