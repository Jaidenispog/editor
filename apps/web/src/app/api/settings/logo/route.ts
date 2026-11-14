import { AppError } from '@studio/core';
import { storageKeys } from '@studio/storage';
import { handleApi, requireOwner } from '@/lib/api';
import { writeAudit } from '@/lib/audit';
import { getLogger } from '@/lib/logger';
import { maybeSignedUrl } from '@/lib/media-links';
import { getSettings, saveSettings } from '@/lib/settings';
import { getBlobStore } from '@/lib/storage';

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Identifies PNG, JPEG and WebP from their first bytes (the browser-supplied type is not trusted). */
function detectImage(buf: Buffer): { ext: 'png' | 'jpg' | 'webp'; mime: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

async function removeOtherLogos(keep: string | null): Promise<void> {
  const store = getBlobStore();
  for (const ext of ['png', 'jpg', 'webp']) {
    const key = storageKeys.brandLogo(ext);
    if (key !== keep) {
      try {
        await store.delete(key);
      } catch (err) {
        getLogger().warn({ err, key }, 'could not remove previous logo');
      }
    }
  }
}

/** POST /api/settings/logo — multipart field "file" (PNG, JPEG or WebP up to 2 MB) stored at brand/logo.<ext>. */
export const POST = handleApi(async ({ req, user }) => {
  requireOwner(user);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError('VALIDATION', 'Choose an image file to upload.');
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw new AppError('VALIDATION', 'Choose an image file to upload.');
  if (file.size > MAX_LOGO_BYTES) throw new AppError('VALIDATION', 'The logo must be 2 MB or smaller.');
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = detectImage(buf);
  if (!kind) throw new AppError('VALIDATION', 'Use a PNG, JPEG or WebP image for the logo.');
  const key = storageKeys.brandLogo(kind.ext);
  await getBlobStore().put(key, buf, { contentType: kind.mime, contentLength: buf.length });
  await removeOtherLogos(key);
  const settings = await getSettings();
  const next = { ...settings, brand: { ...settings.brand, logoStorageKey: key } };
  await saveSettings(next);
  await writeAudit({ userId: user.id, action: 'settings.logo_uploaded', entityType: 'settings', entityId: 'default', data: { bytes: buf.length } });
  return { settings: next, logoUrl: await maybeSignedUrl(key) };
});

/** DELETE /api/settings/logo — removes the logo. */
export const DELETE = handleApi(async ({ user }) => {
  requireOwner(user);
  await removeOtherLogos(null);
  const settings = await getSettings();
  const next = { ...settings, brand: { ...settings.brand, logoStorageKey: null } };
  await saveSettings(next);
  await writeAudit({ userId: user.id, action: 'settings.logo_removed', entityType: 'settings', entityId: 'default' });
  return { settings: next };
});
