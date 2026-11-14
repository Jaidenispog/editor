import type { WorkerModule } from '../types.js';

/** Worker registrations of the email and review requests module (WP7 adds handlers, crons, webhook handlers, cleanup tasks and hooks). */
export const emailModule: WorkerModule = { name: 'email' };
