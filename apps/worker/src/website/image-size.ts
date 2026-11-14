/**
 * Reads an image's pixel width from its first bytes (PNG, GIF, JPEG, WebP), so the check can flag images far wider
 * than any screen without decoding them. Returns null when the format is not recognised or the header is cut short.
 */
export const IMAGE_HEADER_BYTES = 64 * 1024;

export function imageWidthFromHeader(buf: Buffer): number | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16); // PNG IHDR
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') return buf.readUInt16LE(6);
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return 1 + buf.readUIntLE(24, 3);
    if (chunk === 'VP8 ' && buf.length >= 30) return buf.readUInt16LE(26) & 0x3fff;
    if (chunk === 'VP8L' && buf.length >= 25) return 1 + ((((buf[22] ?? 0) & 0x3f) << 8) | (buf[21] ?? 0));
    return null;
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1] ?? 0;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return buf.readUInt16BE(i + 7);
      i += 2 + len;
    }
  }
  return null;
}
