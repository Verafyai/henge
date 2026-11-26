import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * The client suite owns its database. Every run wipes .data/pglite-e2e-client, migrates, seeds and
 * publishes the test-signed update manifest, then starts the website on it. Tests publish releases
 * and memberships, so a reused database would make the next run fail. The dev database in
 * .data/pglite is never touched, and an already running server is never reused.
 */
const E2E_DB = path.resolve(__dirname, '../../.data/pglite-e2e-client');

// A throwaway verifier worker key for this run only. The website learns the public half; the
// worker holds the private half in its environment. Nothing is written to disk.
const worker = generateKeyPairSync('ed25519');
const WORKER_KEY_ID = 'e2e-client-worker';
const workerPublic = worker.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
const workerPrivate = worker.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url');

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  // The client reads seed data through the website's /v1 API.
  webServer: [
    {
      command:
        'pnpm --filter @swarm-explorer/db reset && pnpm --filter @swarm-explorer/client release:test && pnpm --filter @swarm-explorer/web start',
      // DEV_SIGN_IN enables the example-user sign in that stands in for real identity providers.
      // An empty DATABASE_URL keeps every step on the embedded database. SEED_TEST_MODELS adds the two
      // labelled test-only catalog entries this suite needs (packages/db/src/seed-test-models.ts).
      env: { DEV_SIGN_IN: '1', SEED_TEST_MODELS: '1', PGLITE_DIR: E2E_DB, DATABASE_URL: '', VERIFIER_WORKER_KEYS: `${WORKER_KEY_ID}=${workerPublic}` },
      url: 'http://localhost:3000/v1/health',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      // The verifier worker (M6) checks Prompt Guard reproductions against the pinned fixture target.
      command: 'pnpm --filter @swarm-explorer/verifier start',
      env: { VERIFIER_API_URL: 'http://localhost:3000', VERIFIER_KEY_ID: WORKER_KEY_ID, VERIFIER_PRIVATE_KEY: workerPrivate, VERIFIER_POLL_MS: '1000', VERIFIER_HEALTH_PORT: '3199' },
      url: 'http://127.0.0.1:3199/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
