/**
 * Stage C browser test helper: sends one job through the app's own queue package, the way a scheduled run (the
 * per-minute `email.dispatch`, the 10-minute `email.automation.sweep`) or a duplicate delivery (`email.send` for a
 * message already sent) would arrive, so the test does not wait for the next scheduled time.
 *
 *   DATABASE_URL=… tsx apps/web/e2e/enqueue-job.ts <type> '<json payload>'
 *
 * Prints `{"bossJobId":"…"}`; the worker records the run in `jobs` under that pg-boss id.
 */
import { ALL_JOB_TYPES, type JobType } from '@studio/core';
import { createQueue } from '@studio/queue';

const [type, payloadJson] = process.argv.slice(2);
const connectionString = process.env['DATABASE_URL'];
if (!type || !connectionString || !(ALL_JOB_TYPES as readonly string[]).includes(type)) {
  console.error('Usage: DATABASE_URL=… tsx apps/web/e2e/enqueue-job.ts <job type> [json payload]');
  process.exit(2);
}
const payload: unknown = JSON.parse(payloadJson ?? '{}');

const queue = createQueue({ connectionString, role: 'producer', max: 1 });
try {
  await queue.start();
  const bossJobId = await queue.enqueue(type as JobType, payload as never);
  console.log(JSON.stringify({ bossJobId }));
} finally {
  await queue.stop();
}
