import type { RefIdResolver } from './types.js';

/**
 * The entity each publishing job is about, so progress lands on the right card (same answers as the worker's module
 * registration). Returns undefined for job types this module does not own.
 */
export const publishingRefId: RefIdResolver = (type, payload) => {
  const pick = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
  switch (type) {
    case 'publish.prepare':
      return pick('postId');
    case 'publish.target':
    case 'publish.poll':
      return pick('targetId');
    case 'publish.dispatch':
      return null;
    case 'social.check':
      return pick('connectionId');
    default:
      return undefined;
  }
};
