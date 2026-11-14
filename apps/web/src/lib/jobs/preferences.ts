import type { RefIdResolver } from './types.js';

/**
 * The entity each saved preferences, reference video and brand job is about, so progress lands on the right card:
 * `preferences.recompute` is about the preferences (`'preferences'`), `reference.analyse` about its reference asset.
 * Returns undefined for job types this module does not own.
 */
export const preferencesRefId: RefIdResolver = (type, payload) => {
  if (type === 'preferences.recompute') return 'preferences';
  if (type === 'reference.analyse') return typeof payload['assetId'] === 'string' ? payload['assetId'] : null;
  return undefined;
};
