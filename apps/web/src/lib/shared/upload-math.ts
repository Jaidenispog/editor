/**
 * Upload maths shared by the browser uploader and the upload API routes. Pure functions only, so the same
 * rules are applied on both sides and can be unit tested.
 */

/** Part size for chunked uploads: 8 MiB. Kept under the 10 MB request-body buffer of the Next proxy. */
export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;

/** How many attempts the browser makes for one part before giving up on the file. */
export const PART_MAX_ATTEMPTS = 3;

/** Hours an unfinished upload can be resumed before it expires. */
export const UPLOAD_SESSION_TTL_HOURS = 48;

/** Upload kinds the Video Studio accepts. */
export type UploadKind = 'video' | 'audio';

const VIDEO_EXTENSIONS = ['mov', 'mp4', 'm4v'] as const;
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'aac'] as const;

const VIDEO_MIME_TYPES = ['video/quicktime', 'video/mp4', 'video/x-m4v'];
const AUDIO_MIME_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/aac', 'audio/x-aac'];

/** Browsers sometimes send no type (or a generic one) for phone videos; the extension decides then. */
const GENERIC_MIME_TYPES = ['', 'application/octet-stream'];

const CANONICAL_MIME: Record<string, string> = {
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  aac: 'audio/aac',
};

/** Number of parts needed for a file of `size` bytes (an empty file still has no parts). */
export function partCountFor(size: number, partSize: number = UPLOAD_PART_SIZE): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  if (!Number.isInteger(partSize) || partSize <= 0) throw new Error('Part size must be a positive whole number');
  return Math.ceil(size / partSize);
}

/** Byte range [start, end) of part `n` (1-based), or null when the part number is outside the file. */
export function partRange(n: number, size: number, partSize: number = UPLOAD_PART_SIZE): { start: number; end: number } | null {
  const count = partCountFor(size, partSize);
  if (!Number.isInteger(n) || n < 1 || n > count) return null;
  const start = (n - 1) * partSize;
  return { start, end: Math.min(size, start + partSize) };
}

/** Expected byte length of part `n`, or null when the part number is outside the file. */
export function expectedPartSize(n: number, size: number, partSize: number = UPLOAD_PART_SIZE): number | null {
  const range = partRange(n, size, partSize);
  return range ? range.end - range.start : null;
}

/** Part numbers (1-based, ascending) still missing given the parts the server already has. */
export function missingParts(partCount: number, received: readonly number[]): number[] {
  const have = new Set(received);
  const out: number[] = [];
  for (let n = 1; n <= partCount; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** Bytes already stored on the server for the received parts. */
export function receivedBytes(size: number, received: readonly number[], partSize: number = UPLOAD_PART_SIZE): number {
  let total = 0;
  for (const n of new Set(received)) total += expectedPartSize(n, size, partSize) ?? 0;
  return total;
}

/** Delay before retry `attempt` (1-based) of a failed part: 1 s, 2 s, 4 s … capped at 15 s. */
export function retryDelayMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

/** Lower-case file extension without the dot ('' when there is none). */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** Whether an upload of this kind should be accepted; returns the canonical type and extension or a plain reason. */
export function checkUploadFile(input: { filename: string; mimeType: string; kind: UploadKind }):
  | { ok: true; extension: string; mimeType: string }
  | { ok: false; reason: string } {
  const ext = fileExtension(input.filename);
  const mime = input.mimeType.trim().toLowerCase();
  if (input.kind === 'video') {
    if (!(VIDEO_EXTENSIONS as readonly string[]).includes(ext)) {
      return { ok: false, reason: 'Only .mov, .mp4 and .m4v video files can be added.' };
    }
    if (!VIDEO_MIME_TYPES.includes(mime) && !GENERIC_MIME_TYPES.includes(mime)) {
      return { ok: false, reason: 'This file does not look like a phone video. Please choose a .mov, .mp4 or .m4v file.' };
    }
    return { ok: true, extension: ext, mimeType: VIDEO_MIME_TYPES.includes(mime) ? mime : (CANONICAL_MIME[ext] ?? 'video/mp4') };
  }
  if (!(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: 'Only .mp3, .m4a, .wav and .aac music files can be added.' };
  }
  if (!AUDIO_MIME_TYPES.includes(mime) && !GENERIC_MIME_TYPES.includes(mime)) {
    return { ok: false, reason: 'This file does not look like a music track. Please choose an .mp3, .m4a, .wav or .aac file.' };
  }
  return { ok: true, extension: ext, mimeType: CANONICAL_MIME[ext] ?? 'audio/mpeg' };
}

/** File input `accept` attribute for each kind. */
export const UPLOAD_ACCEPT: Record<UploadKind, string> = {
  video: '.mov,.mp4,.m4v,video/quicktime,video/mp4,video/x-m4v',
  audio: '.mp3,.m4a,.wav,.aac,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/aac',
};

/** localStorage key that remembers an unfinished upload for the same file (name + size + last modified). */
export function resumeStorageKey(projectId: string, file: { name: string; size: number; lastModified: number }): string {
  return `studio-upload:${projectId}:${file.name}:${file.size}:${file.lastModified}`;
}
