import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { ALL_JOB_TYPES, JOB_TYPES } from '@studio/core';
import { JobQueue, QUEUE_HEARTBEAT_SECONDS } from '@studio/queue';
import { createTestDatabase, testDatabaseUrl } from './helpers/db.js';

const logger = pino({ level: 'silent' });
const skip = !testDatabaseUrl();

describe.skipIf(skip)('queue settings on a real database', () => {
  let url: string;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    const t = await createTestDatabase();
    url = t.url;
    drop = t.drop;
  }, 60_000);
  afterAll(async () => {
    await drop();
  });

  it('creates every queue with a 30 s heartbeat and brings older queues up to date', async () => {
    // A producer creates the queues first (as the web app may), then an older setting is simulated.
    const producer = new JobQueue({ connectionString: url, role: 'producer', logger, max: 2 });
    await producer.start();
    for (const type of ALL_JOB_TYPES) expect((await producer.raw.getQueue(type))?.heartbeatSeconds, type).toBe(QUEUE_HEARTBEAT_SECONDS);
    await producer.raw.updateQueue(JOB_TYPES.RENDER_EXPORT, { heartbeatSeconds: 60 });
    expect((await producer.raw.getQueue(JOB_TYPES.RENDER_EXPORT))?.heartbeatSeconds).toBe(60);
    await producer.stop(false);

    const worker = new JobQueue({ connectionString: url, role: 'worker', logger, max: 2 });
    await worker.start();
    try {
      for (const type of ALL_JOB_TYPES) expect((await worker.raw.getQueue(type))?.heartbeatSeconds, type).toBe(QUEUE_HEARTBEAT_SECONDS);
    } finally {
      await worker.stop(false);
    }
  }, 60_000);
});
