import 'server-only';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, type Env } from '@studio/config';

let rootEnvLoaded = false;

/**
 * Finds the monorepo root (the folder holding pnpm-workspace.yaml) by walking up from `start`.
 * Returns null in deployments where only the standalone server was copied.
 */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Loads the repository-root `.env` once (local development keeps a single `.env` at the root that both the
 * web app and the worker share). Values already present in the process environment always win.
 */
function loadRootEnvFile(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;
  const root = findRepoRoot();
  if (!root) return;
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Returns the validated server environment. Call it inside request handlers or server components, never at
 * module import time, so `next build` succeeds without a database or secrets.
 */
export function getEnv(): Env {
  loadRootEnvFile();
  return loadEnv();
}

/**
 * Resolves a configured path (e.g. STORAGE_LOCAL_ROOT=./data/storage) against the repository root when it is
 * relative, so the web app and the worker agree on the same folder regardless of their working directories.
 */
export function resolveConfiguredPath(configured: string): string {
  if (path.isAbsolute(configured)) return configured;
  const root = findRepoRoot();
  return path.resolve(root ?? process.cwd(), configured);
}
