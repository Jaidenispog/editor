import type { RefIdResolver } from './types.js';

/**
 * The entity each email and review requests job is about, matching the worker's `refIdFor`, so progress lands on the
 * right card. Returns undefined for job types this module does not own.
 */
export const emailRefId: RefIdResolver = (type, payload) => {
  const pick = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
  switch (type) {
    case 'email.send':
      return pick('emailMessageId');
    case 'email.campaign.expand':
      return pick('campaignId');
    case 'email.suppression.push':
      return pick('suppressionId');
    case 'email.dispatch':
    case 'email.automation.sweep':
    case 'email.provider.check':
    case 'reviews.places.sync':
      return null;
    default:
      return undefined;
  }
};
