import type { RefIdResolver } from './types.js';

/**
 * The entity each trends job is about, so progress lands on the right card: `trends.refresh` is about its watch
 * (null for the daily run over every watch). Returns undefined for job types this module does not own.
 */
export const trendsRefId: RefIdResolver = (type, payload) => {
  if (type !== 'trends.refresh') return undefined;
  return typeof payload['watchId'] === 'string' ? payload['watchId'] : null;
};
