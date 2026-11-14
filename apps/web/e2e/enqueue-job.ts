/**
 * Stage C browser test helper: sends one job straight to the queue through the app's own queue package, the way a
 * duplicate delivery or a manual re-run would arrive (for example a second `website.edit_apply` for a change that is
 * already applied). The worker must do nothing more.
 *
 *   DATABASE_URL=… tsx apps/web/e2e/enqueue-job.ts <type> '<json payload>'
 *
 * Prints `{"bossJobId":"…"}`; the worker records the run in `jobs` under that pg-boss id. The payload is checked
 * against the job type's schema in @studio/core first, so only a job the app itself could send is sent.
 */
import { JOB_PAYLOAD_SCHEMAS, isJobType } from '@studio/core';
import { createQueue } from '@studio/queue';

const [type, payloadText] = process.argv.slice(2);
const connectionString = process.env['DATABASE_URL'];
if (!type || !payloadText || !connectionString || !isJobType(type)) {
  console.error("Usage: DATABASE_URL=… tsx apps/web/e2e/enqueue-job.ts <job type> '<json payload>'");
  process.exit(2);
}
const schemaForType: { safeParse(v: unknown): { success: boolean; data?: unknown } } = JOB_PAYLOAD_SCHEMAS[type];
const parsed = schemaForType.safeParse(JSON.parse(payloadText));
if (!parsed.success) {
  console.error(`That payload does not fit ${type}.`);
  process.exit(2);
}

const queue = createQueue({ connectionString, role: 'producer', max: 1 });
try {
  await queue.start();
  const bossJobId = await queue.enqueue(type, parsed.data as never);
  console.log(JSON.stringify({ bossJobId }));
} finally {
  await queue.stop();
}
