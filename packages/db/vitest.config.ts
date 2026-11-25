import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file gets a throwaway in-memory database; never the dev database.
    env: { PGLITE_DIR: 'memory://', DATABASE_URL: '' },
    testTimeout: 30_000,
  },
});
