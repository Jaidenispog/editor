/**
 * Stage B browser test helper: sends one more `publish.target` job for a destination that has already been handled,
 * through the app's own queue package, the way a duplicate delivery or a manual re-run would arrive. The worker must
 * refuse to publish it again (the conditional claim in `apps/worker/src/handlers/publish-target.ts`).
 *
 *   DATABASE_URL=… tsx apps/web/e2e/requeue-job.ts <postId> <targetId> [projectId]
 *
 * Prints `{"bossJobId":"…"}`; the worker records the run in `jobs` under that pg-boss id.
 */
import { createQueue } from '@studio/queue';

const [postId, targetId, projectId] = process.argv.slice(2);
const connectionString = process.env['DATABASE_URL'];
if (!postId || !targetId || !connectionString) {
  console.error('Usage: DATABASE_URL=… tsx apps/web/e2e/requeue-job.ts <postId> <targetId> [projectId]');
  process.exit(2);
}

const queue = createQueue({ connectionString, role: 'producer', max: 1 });
try {
  await queue.start();
  const bossJobId = await queue.enqueue('publish.target', { postId, targetId, projectId: projectId || null });
  console.log(JSON.stringify({ bossJobId }));
} finally {
  await queue.stop();
}
