import type { RefIdResolver } from './types.js';

/**
 * The entity each website check and Search Console job is about, so progress lands on the right card (WP8 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const websiteRefId: RefIdResolver = () => undefined;
