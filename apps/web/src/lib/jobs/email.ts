import type { RefIdResolver } from './types.js';

/**
 * The entity each email and review requests job is about, so progress lands on the right card (WP7 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const emailRefId: RefIdResolver = () => undefined;
