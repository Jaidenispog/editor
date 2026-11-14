import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workerNotice, type WorkerStatusDto } from '../src/lib/shared/worker-notice';

/** The heartbeat read is replaced so the fallback can be tested without a database. */
const db = vi.hoisted(() => ({ read: null as null | (() => Promise<{ alive: boolean; lastSeenAt: Date | null }>) }));
vi.mock('@studio/db', () => ({ readWorkerStatus: () => db.read!() }));
vi.mock('../src/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('../src/lib/logger', () => ({ getLogger: () => ({ warn: () => {} }) }));

const { getWorkerStatus } = await import('../src/lib/worker-status');

const stopped: WorkerStatusDto = { alive: false, lastSeenAt: '2026-11-14T00:00:00.000Z', startHint: 'dev' };
const running: WorkerStatusDto = { alive: true, lastSeenAt: '2026-11-14T00:00:30.000Z', startHint: 'dev' };

describe('workerNotice', () => {
  it('explains the stopped worker while clips or edits wait, with how to start it', () => {
    expect(workerNotice(stopped, true)).toEqual({
      title: "The background worker isn't running",
      body: 'Clips and edits are waiting for it. Start the app with bash scripts/dev.sh (or pnpm dev:worker), and they will start by themselves.',
    });
    // Never seen at all (no heartbeat row) reads the same.
    expect(workerNotice({ ...stopped, lastSeenAt: null }, true)?.title).toBe("The background worker isn't running");
  });

  it('shows nothing new when the worker is running, waiting or not', () => {
    expect(workerNotice(running, true)).toBeNull();
    expect(workerNotice(running, false, { whenIdle: true })).toBeNull();
  });

  it('shows nothing on the project page when nothing is waiting', () => {
    expect(workerNotice(stopped, false)).toBeNull();
  });

  it('gives the quieter dashboard wording when nothing is waiting yet', () => {
    expect(workerNotice(stopped, false, { whenIdle: true })?.body).toBe('New clips and edits will wait until it starts. Start the app with bash scripts/dev.sh (or pnpm dev:worker).');
  });

  it('does not claim anything when the status was not checked', () => {
    expect(workerNotice(null, true)).toBeNull();
    expect(workerNotice(undefined, true, { whenIdle: true })).toBeNull();
  });

  it('points a hosted server at the worker service instead of the local script', () => {
    const body = workerNotice({ ...stopped, startHint: 'service' }, true)?.body ?? '';
    expect(body).toContain('Start the worker service again');
    expect(body).not.toContain('dev.sh');
  });
});

describe('getWorkerStatus', () => {
  beforeEach(() => {
    db.read = null;
  });

  it('passes the heartbeat through as plain JSON', async () => {
    db.read = async () => ({ alive: true, lastSeenAt: new Date('2026-11-14T01:02:03Z') });
    expect(await getWorkerStatus()).toEqual({ alive: true, lastSeenAt: '2026-11-14T01:02:03.000Z', startHint: 'dev' });
  });

  it('reports "not running" when the heartbeat cannot be read (never claims it is running)', async () => {
    db.read = async () => {
      throw new Error('relation "worker_heartbeats" does not exist');
    };
    expect(await getWorkerStatus()).toEqual({ alive: false, lastSeenAt: null, startHint: 'dev' });
  });
});
