export * from './types.js';
export * from './signing.js';
export * from './keys.js';
export { LocalDiskStore, type LocalDiskStoreOptions } from './local.js';
export { S3Store, type S3StoreOptions } from './s3.js';
import type { Env } from '@studio/config';
import { LocalDiskStore } from './local.js';
import { S3Store } from './s3.js';
import type { BlobStore } from './types.js';

export function createBlobStore(env: Env): BlobStore {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3Store({
      bucket: env.S3_BUCKET!,
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalDiskStore({ rootDir: env.STORAGE_LOCAL_ROOT, appUrl: env.APP_URL, secret: env.APP_SECRET });
}
