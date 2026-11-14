import type { RefIdResolver } from './types.js';

/**
 * The entity each saved preferences, reference video and brand job is about, so progress lands on the right card (WP2 fills this in). Returns
 * undefined for job types this module does not own.
 */
export const preferencesRefId: RefIdResolver = () => undefined;
