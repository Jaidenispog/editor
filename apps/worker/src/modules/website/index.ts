import type { WorkerModule } from '../types.js';

/** Worker registrations of the website check and Search Console module (WP8 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const websiteModule: WorkerModule = { name: 'website' };
