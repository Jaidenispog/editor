import type { WorkerModule } from '../types.js';

/** Worker registrations of the music controls and licence passport module (WP1 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const musicModule: WorkerModule = { name: 'music' };
