import { describe, expect, it } from 'vitest';
import { ALL_JOB_TYPES } from '@studio/core';
import { DEFAULT_QUEUE_POOL_MAX, QUEUE_HEARTBEAT_SECONDS, QUEUE_SETTINGS, QUEUE_SUPERVISE_INTERVAL_SECONDS } from '../src/index.js';

describe('queue settings', () => {
  it('uses a 30 s heartbeat for every job type and a 30 s supervisor pass', () => {
    expect(QUEUE_HEARTBEAT_SECONDS).toBe(30);
    expect(QUEUE_SUPERVISE_INTERVAL_SECONDS).toBe(30);
    for (const type of ALL_JOB_TYPES) {
      const s = QUEUE_SETTINGS[type];
      expect(s.heartbeatSeconds, type).toBe(30);
      // pg-boss rejects heartbeats under 10 s; every attempt must outlive several heartbeats.
      expect(s.heartbeatSeconds).toBeGreaterThanOrEqual(10);
      expect(s.expireInSeconds).toBeGreaterThan(s.heartbeatSeconds * 4);
    }
  });

  it('keeps the default pool sizes', () => {
    expect(DEFAULT_QUEUE_POOL_MAX).toEqual({ producer: 3, worker: 6 });
  });
});
