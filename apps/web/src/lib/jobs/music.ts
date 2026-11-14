import type { RefIdResolver } from './types.js';

/**
 * The entity each music controls and licence passport job is about, so progress lands on the right card (WP1 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const musicRefId: RefIdResolver = () => undefined;
