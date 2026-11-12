import type { Readable } from 'node:stream';

export interface PutOptions {
  contentType?: string;
  /** Known size in bytes, when available (lets drivers avoid buffering). */
  contentLength?: number;
}

export interface SignedUrlOptions {
  expiresInSeconds: number;
  /** When set, the response is served as an attachment with this filename. */
  downloadName?: string;
  contentType?: string;
}

export interface StatResult {
  size: number;
  contentType: string | null;
  lastModified: Date | null;
}

export interface ReadRange {
  start: number;
  /** Inclusive end byte. */
  end?: number;
}

export interface MultipartUpload {
  uploadId: string;
  key: string;
}

export interface MultipartPart {
  partNumber: number;
  /** Driver-specific identifier (ETag for S3, byte length for local). */
  etag: string;
  size: number;
}

/**
 * Private blob storage. Keys are POSIX-style relative paths (e.g. projects/<id>/assets/<id>/original.mov).
 * Implementations: LocalDiskStore (dev / single server) and S3Store (Supabase Storage S3, Cloudflare R2, AWS S3).
 */
export interface BlobStore {
  readonly driver: 'local' | 's3';
  put(key: string, body: Readable | Buffer, options?: PutOptions): Promise<void>;
  /** Uploads a local file (used by the worker after rendering). */
  putFile(key: string, filePath: string, options?: PutOptions): Promise<void>;
  getStream(key: string, range?: ReadRange): Promise<Readable>;
  /** Downloads a blob to a local path (used by the worker before processing). */
  downloadToFile(key: string, filePath: string): Promise<void>;
  stat(key: string): Promise<StatResult | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  list(prefix: string): Promise<string[]>;
  /** Expiring link a browser can fetch directly (S3 presigned URL, or an HMAC-signed app route for local). */
  signedUrl(key: string, options: SignedUrlOptions): Promise<string>;

  createMultipart(key: string, options?: PutOptions): Promise<MultipartUpload>;
  uploadPart(upload: MultipartUpload, partNumber: number, body: Buffer): Promise<MultipartPart>;
  completeMultipart(upload: MultipartUpload, parts: MultipartPart[]): Promise<void>;
  abortMultipart(upload: MultipartUpload): Promise<void>;
}

export function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\') || /[\u0000-\u001f]/.test(key)) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
}

export function contentTypeForKey(key: string): string {
  const ext = key.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'm4v':
      return 'video/x-m4v';
    case 'webm':
      return 'video/webm';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'wav':
      return 'audio/wav';
    case 'json':
      return 'application/json';
    case 'ass':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
