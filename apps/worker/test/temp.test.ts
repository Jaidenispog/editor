import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, utimes, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupStaleTempDirs, createJobTempDir, removeTempDir } from '../src/lib/temp.js';

describe('temp dirs', () => {
  it('creates, removes and cleans stale directories only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sa-worker-'));
    const fresh = await createJobTempDir(root, 'fresh');
    const old = await createJobTempDir(root, 'old');
    await mkdir(path.join(root, 'unrelated'));
    const past = new Date(Date.now() - 48 * 3600_000);
    await utimes(old, past, past);
    const removed = await cleanupStaleTempDirs(root, 24 * 3600_000);
    expect(removed).toBe(1);
    await expect(stat(fresh)).resolves.toBeTruthy();
    await expect(stat(old)).rejects.toThrow();
    await removeTempDir(fresh);
    await expect(stat(fresh)).rejects.toThrow();
    await removeTempDir(root);
  });
});
