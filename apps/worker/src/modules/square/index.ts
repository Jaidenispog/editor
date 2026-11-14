import type { WorkerModule } from '../types.js';

/** Worker registrations of the Square appointments module (WP6 and WP6b adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const squareModule: WorkerModule = { name: 'square' };
