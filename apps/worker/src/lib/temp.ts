import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

/** Creates an isolated temp directory for one job attempt. */
export async function createJobTempDir(root: string, jobId: string): Promise<string> {
  const dir = path.join(root, `job-${jobId}-${Date.now().toString(36)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Removes temp directories older than the given age (orphans left by crashes). Returns the count removed. */
export async function cleanupStaleTempDirs(root: string, olderThanMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const name of entries) {
    if (!name.startsWith('job-')) continue;
    const full = path.join(root, name);
    try {
      const s = await stat(full);
      if (now - s.mtimeMs > olderThanMs) {
        await rm(full, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // ignore races with concurrent jobs
    }
  }
  return removed;
}
