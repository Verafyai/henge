import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The client suite owns its database. Every run wipes .data/pglite-e2e-client, migrates, seeds and
 * publishes the test-signed update manifest, then starts the website on it. Tests publish releases
 * and memberships, so a reused database would make the next run fail. The dev database in
 * .data/pglite is never touched, and an already running server is never reused.
 */
const E2E_DB = path.resolve(__dirname, '../../.data/pglite-e2e-client');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  // The client reads seed data through the website's /v1 API.
  webServer: {
    command:
      'pnpm --filter @swarm-explorer/db reset && pnpm --filter @swarm-explorer/client release:test && pnpm --filter @swarm-explorer/web start',
    // DEV_SIGN_IN enables the example-user sign in that stands in for real identity providers.
    // An empty DATABASE_URL keeps every step on the embedded database.
    env: { DEV_SIGN_IN: '1', PGLITE_DIR: E2E_DB, DATABASE_URL: '' },
    url: 'http://localhost:3000/v1/health',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
