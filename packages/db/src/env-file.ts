import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads the repository-root .env (the single file the web app and worker share) for the command-line scripts.
 * Values already present in the process environment always win. Does nothing in deployments without the file.
 */
export function loadRootEnvFile(): void {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      const file = path.join(dir, '.env');
      if (existsSync(file)) process.loadEnvFile(file);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
