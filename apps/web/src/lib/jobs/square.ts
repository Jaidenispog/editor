import type { RefIdResolver } from './types.js';

/**
 * The entity each Square appointments job is about, so progress lands on the right card (the worker's module index
 * answers the same). Returns undefined for job types this module does not own.
 */
export const squareRefId: RefIdResolver = (type, payload) => {
  const pick = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
  switch (type) {
    case 'square.availability':
      return pick('searchId');
    case 'square.refresh':
      return pick('squareId');
    case 'square.sync':
    case 'square.attendance':
    case 'square.token_refresh':
    case 'square.revoke':
      return null;
    default:
      return undefined;
  }
};
