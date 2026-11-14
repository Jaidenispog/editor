import type { WorkerModule } from '../types.js';

/** Worker registrations of the publishing module (WP4 and WP10 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const publishingModule: WorkerModule = { name: 'publishing' };
