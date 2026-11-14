import 'server-only';
import { createBlobStore, type BlobStore } from '@studio/storage';
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

/**
 * The store when the local-disk driver is active (the media route serves its files), otherwise null.
 * Checks the driver tag rather than the class: bundlers can load @studio/storage more than once (webpack dev does),
 * and then `instanceof` fails for a store created by another copy of the module, so every link would 404.
 */
export function getLocalDiskStore(): BlobStore | null {
  const store = getBlobStore();
  return store.driver === 'local' ? store : null;
}
