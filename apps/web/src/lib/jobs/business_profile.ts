import type { RefIdResolver } from './types.js';

/**
 * The entity each Google Business Profile job is about, so progress lands on the right card (WP9 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const businessProfileRefId: RefIdResolver = () => undefined;
