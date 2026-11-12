import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { assertSafeKey, contentTypeForKey } from './types.js';
import type { BlobStore, MultipartPart, MultipartUpload, PutOptions, ReadRange, SignedUrlOptions, StatResult } from './types.js';
import { signMediaLink } from './signing.js';

export interface LocalDiskStoreOptions {
  rootDir: string;
  /** Base URL of the web app that serves /api/media/<token>. */
  appUrl: string;
  secret: string;
}

/**
 * Filesystem-backed store for local development and single-server deployments.
 * Signed links point at the web app, which verifies the HMAC token and streams the file with Range support.
 */
export class LocalDiskStore implements BlobStore {
  readonly driver = 'local' as const;
  private readonly root: string;
  constructor(private readonly options: LocalDiskStoreOptions) {
    this.root = path.resolve(options.rootDir);
  }

  resolvePath(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep) && full !== this.root) throw new Error('Key escapes storage root');
    return full;
  }

  private async ensureDir(filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
  }

  async put(key: string, body: Readable | Buffer, _options: PutOptions = {}): Promise<void> {
    const dest = this.resolvePath(key);
    await this.ensureDir(dest);
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
    if (Buffer.isBuffer(body)) {
      await writeFile(tmp, body);
    } else {
      await pipeline(body, createWriteStream(tmp));
    }
    await rename(tmp, dest);
  }

  async putFile(key: string, filePath: string): Promise<void> {
    const dest = this.resolvePath(key);
    await this.ensureDir(dest);
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
    await copyFile(filePath, tmp);
    await rename(tmp, dest);
  }

  async getStream(key: string, range?: ReadRange): Promise<Readable> {
    const file = this.resolvePath(key);
    await access(file);
    return createReadStream(file, range ? { start: range.start, end: range.end } : undefined);
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await copyFile(this.resolvePath(key), filePath);
  }

  async stat(key: string): Promise<StatResult | null> {
    try {
      const s = await stat(this.resolvePath(key));
      if (!s.isFile()) return null;
      return { size: s.size, contentType: contentTypeForKey(key), lastModified: s.mtime };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = this.resolvePath(prefix);
    const keys = await this.list(prefix);
    await rm(dir, { recursive: true, force: true });
    return keys.length;
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolvePath(prefix);
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && !e.name.includes('.part-')) out.push(path.relative(this.root, p).split(path.sep).join('/'));
      }
    };
    await walk(dir);
    return out.sort();
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    assertSafeKey(key);
    const token = signMediaLink(
      {
        key,
        exp: Math.floor(Date.now() / 1000) + options.expiresInSeconds,
        ...(options.downloadName ? { downloadName: options.downloadName } : {}),
        ...(options.contentType ? { contentType: options.contentType } : {}),
      },
      this.options.secret,
    );
    return `${this.options.appUrl.replace(/\/$/, '')}/api/media/${token}`;
  }

  // --- multipart: parts are staged next to the target and concatenated on completion
  private partsDir(upload: MultipartUpload): string {
    return this.resolvePath(`${upload.key}.multipart-${upload.uploadId}`);
  }

  async createMultipart(key: string): Promise<MultipartUpload> {
    assertSafeKey(key);
    const upload = { uploadId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, key };
    await mkdir(this.partsDir(upload), { recursive: true });
    return upload;
  }

  async uploadPart(upload: MultipartUpload, partNumber: number, body: Buffer): Promise<MultipartPart> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error('Invalid part number');
    const file = path.join(this.partsDir(upload), `${partNumber.toString().padStart(5, '0')}.part`);
    await writeFile(file, body);
    return { partNumber, etag: String(body.length), size: body.length };
  }

  async completeMultipart(upload: MultipartUpload, parts: MultipartPart[]): Promise<void> {
    const dir = this.partsDir(upload);
    const dest = this.resolvePath(upload.key);
    await this.ensureDir(dest);
    const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
    const handle = await open(tmp, 'w');
    try {
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      for (const p of ordered) {
        const file = path.join(dir, `${p.partNumber.toString().padStart(5, '0')}.part`);
        // Parts are bounded (a few MiB) so a sequential read/write keeps memory flat and avoids stream edge cases.
        const buf = await readFile(file);
        await handle.write(buf);
      }
    } finally {
      await handle.close();
    }
    await rename(tmp, dest);
    await rm(dir, { recursive: true, force: true });
  }

  async abortMultipart(upload: MultipartUpload): Promise<void> {
    await rm(this.partsDir(upload), { recursive: true, force: true });
  }
}
