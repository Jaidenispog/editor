import type { RefIdResolver } from './types.js';

/**
 * The entity each Square appointments job is about, so progress lands on the right card (WP6 and WP6b fills this in). Returns
 * undefined for job types this module does not own.
 */
export const squareRefId: RefIdResolver = () => undefined;
