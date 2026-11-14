/**
 * Whether the background worker is running, as the web app shows it. Built on the server from the worker heartbeat
 * table (`lib/worker-status.ts`); `alive` is true only when a worker recorded a heartbeat in the last 60 s.
 */
export interface WorkerStatusDto {
  alive: boolean;
  /** Latest heartbeat of any worker (ISO), or null when none is recorded (never started, or stopped cleanly). */
  lastSeenAt: string | null;
  /** Which start instructions fit this server: the local development script, or a hosted worker service. */
  startHint: 'dev' | 'service';
}

/** A notice for the owner: a short title and one or two plain sentences. */
export interface WorkerNotice {
  title: string;
  body: string;
}

const HOW_TO_START: Record<WorkerStatusDto['startHint'], string> = {
  dev: 'Start the app with bash scripts/dev.sh (or pnpm dev:worker)',
  service: 'Start the worker service again (see docs/deployment.md)',
};

/**
 * The calm notice shown where the owner would otherwise wait for nothing: only when no worker is running AND
 * something is queued or in progress. Never shown when the worker is alive, or when its status is unknown (null),
 * so the app never claims anything it has not checked.
 *
 * `waiting` is true when clips, edits, exports or other jobs are queued or in progress. With `whenIdle: true` a
 * quieter version is returned even when nothing is waiting (the dashboard, where new work would wait too).
 */
export function workerNotice(worker: WorkerStatusDto | null | undefined, waiting: boolean, options: { whenIdle?: boolean } = {}): WorkerNotice | null {
  if (!worker || worker.alive) return null;
  const start = HOW_TO_START[worker.startHint] ?? HOW_TO_START.dev;
  if (waiting) {
    return {
      title: "The background worker isn't running",
      body: `Clips and edits are waiting for it. ${start}, and they will start by themselves.`,
    };
  }
  if (!options.whenIdle) return null;
  return {
    title: "The background worker isn't running",
    body: `New clips and edits will wait until it starts. ${start}.`,
  };
}
