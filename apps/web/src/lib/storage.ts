import 'server-only';
import { createBlobStore, LocalDiskStore, type BlobStore } from '@studio/storage';
import { getEnv, resolveConfiguredPath } from './env.js';

const globalForStore = globalThis as unknown as { __studioWebStore?: BlobStore };

/** Private blob store (local disk or S3-compatible), created once per process. */
export function getBlobStore(): BlobStore {
  if (!globalForStore.__studioWebStore) {
    const env = getEnv();
    globalForStore.__studioWebStore = createBlobStore({ ...env, STORAGE_LOCAL_ROOT: resolveConfiguredPath(env.STORAGE_LOCAL_ROOT) });
  }
  return globalForStore.__studioWebStore;
}

/** The local-disk store when that driver is active (used by the media route), otherwise null. */
export function getLocalDiskStore(): LocalDiskStore | null {
  const store = getBlobStore();
  return store instanceof LocalDiskStore ? store : null;
}
