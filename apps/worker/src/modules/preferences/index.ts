import type { WorkerModule } from '../types.js';

/** Worker registrations of the saved preferences, reference video and brand module (WP2 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const preferencesModule: WorkerModule = { name: 'preferences' };
