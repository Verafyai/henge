import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    // Database tests get a throwaway in-memory PGlite, never the dev database.
    env: { PGLITE_DIR: 'memory://', DATABASE_URL: '' },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
