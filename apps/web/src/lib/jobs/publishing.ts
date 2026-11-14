import type { RefIdResolver } from './types.js';

/**
 * The entity each publishing job is about, so progress lands on the right card (WP4 and WP10 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const publishingRefId: RefIdResolver = () => undefined;
