import type { WorkerModule } from '../types.js';

/** Worker registrations of the trends module (WP3 and WP5 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const trendsModule: WorkerModule = { name: 'trends' };
