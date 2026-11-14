/** A satisfiable byte range (both ends inclusive). */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses an HTTP Range header for a resource of `size` bytes.
 * - null: no usable range (absent, not "bytes=", or multi-range) → serve the whole file with 200.
 * - 'unsatisfiable': a syntactically valid range that falls outside the file → 416.
 * - ByteRange: serve 206 with that slice. Supports "a-b", "a-" and suffix "-n" forms.
 */
export function parseRangeHeader(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^\s*bytes\s*=\s*(.+)$/i.exec(header);
  if (!match || !match[1]) return null;
  const spec = match[1].trim();
  if (spec.includes(',')) return null; // multi-range responses are not supported; send the full body
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!parts) return null;
  const [, startText = '', endText = ''] = parts;
  if (startText === '' && endText === '') return null;
  if (size <= 0) return 'unsatisfiable';
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  let end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isSafeInteger(end)) return null;
  if (end < start) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

/** Content-Disposition value for a download, with an ASCII fallback and an RFC 5987 UTF-8 filename. */
export function contentDispositionAttachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
