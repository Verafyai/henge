import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  // The client reads seed data through the website's /v1 API.
  webServer: {
    // DEV_SIGN_IN enables the example-user sign in that stands in for real identity providers.
    command: 'pnpm --filter @swarm-explorer/web start',
    env: { DEV_SIGN_IN: '1' },
    url: 'http://localhost:3000/v1/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
