import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertSafeKey, contentTypeForKey } from './types.js';
import type { BlobStore, MultipartPart, MultipartUpload, PutOptions, ReadRange, SignedUrlOptions, StatResult } from './types.js';

export interface S3StoreOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/**
 * S3-compatible store. Works with Supabase Storage (S3 protocol), Cloudflare R2 and AWS S3.
 * Buckets must be private; browsers only ever receive presigned, expiring URLs.
 */
export class S3Store implements BlobStore {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  constructor(private readonly options: S3StoreOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async put(key: string, body: Readable | Buffer, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.options.bucket, Key: key, Body: body, ContentType: options.contentType ?? contentTypeForKey(key) },
      partSize: 8 * 1024 * 1024,
      queueSize: 3,
    });
    await upload.done();
  }

  async putFile(key: string, filePath: string, options: PutOptions = {}): Promise<void> {
    await this.put(key, createReadStream(filePath), options);
  }

  async getStream(key: string, range?: ReadRange): Promise<Readable> {
    assertSafeKey(key);
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ...(range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}),
      }),
    );
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    return res.Body as Readable;
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const stream = await this.getStream(key);
    await pipeline(stream, createWriteStream(filePath));
  }

  async stat(key: string): Promise<StatResult | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return { size: res.ContentLength ?? 0, contentType: res.ContentType ?? null, lastModified: res.LastModified ?? null };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound' || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    assertSafeKey(prefix);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: prefix.endsWith('/') ? prefix : `${prefix}/`, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys = await this.list(prefix);
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({ Bucket: this.options.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }),
      );
    }
    return keys.length;
  }

  async signedUrl(key: string, options: SignedUrlOptions): Promise<string> {
    assertSafeKey(key);
    const cmd = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ...(options.downloadName ? { ResponseContentDisposition: `attachment; filename="${options.downloadName.replace(/"/g, '')}"` } : {}),
      ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn: options.expiresInSeconds });
  }

  async createMultipart(key: string, options: PutOptions = {}): Promise<MultipartUpload> {
    assertSafeKey(key);
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.options.bucket, Key: key, ContentType: options.contentType ?? contentTypeForKey(key) }),
    );
    if (!res.UploadId) throw new Error('S3 did not return an upload id');
    return { uploadId: res.UploadId, key };
  }

  async uploadPart(upload: MultipartUpload, partNumber: number, body: Buffer): Promise<MultipartPart> {
    const res = await this.client.send(
      new UploadPartCommand({ Bucket: this.options.bucket, Key: upload.key, UploadId: upload.uploadId, PartNumber: partNumber, Body: body }),
    );
    if (!res.ETag) throw new Error('S3 did not return an ETag for the part');
    return { partNumber, etag: res.ETag, size: body.length };
  }

  async completeMultipart(upload: MultipartUpload, parts: MultipartPart[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.options.bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
        MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
  }

  async abortMultipart(upload: MultipartUpload): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.options.bucket, Key: upload.key, UploadId: upload.uploadId }));
  }
}
