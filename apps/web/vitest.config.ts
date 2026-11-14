import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Unit tests for the server-side helpers in src/lib run in plain Node (no browser, no database). */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.join(here, 'src'),
      // "server-only" throws outside the React server bundle; tests import server modules directly.
      'server-only': path.join(here, 'test/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
