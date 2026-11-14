import type { RefIdResolver } from './types.js';

/**
 * The entity each trends job is about, so progress lands on the right card (WP3 and WP5 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const trendsRefId: RefIdResolver = () => undefined;
