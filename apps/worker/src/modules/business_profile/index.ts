import type { WorkerModule } from '../types.js';

/** Worker registrations of the Google Business Profile module (WP9 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const businessProfileModule: WorkerModule = { name: 'business_profile' };
