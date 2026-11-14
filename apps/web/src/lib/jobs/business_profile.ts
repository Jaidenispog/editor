import type { RefIdResolver } from './types.js';

/**
 * The entity each Google Business Profile job is about, so progress lands on the right card (same rule as the
 * worker's module registration). Returns undefined for job types this module does not own.
 */
export const businessProfileRefId: RefIdResolver = (type) => (type === 'reviews.gbp.sync' ? 'google_business_profile' : undefined);
