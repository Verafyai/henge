import { expect, test } from '@playwright/test';

const FORBIDDEN = /crowdfund|constitution|treasury|USDC|cash out your|withdraw|back this|stage \d/i;

test('the swarm store lists the launch swarms as example data, browse-only', async ({ page }) => {
  await page.goto('/swarms');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('An app store for swarms.');
  await expect(page.getByText('Example data').first()).toBeVisible();
  for (const name of ['Challenge Vaults', 'Verafy DAO juries', 'Prompt Guard red team']) {
    await expect(page.getByRole('heading', { name, level: 3 })).toBeVisible();
  }
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/[–—]/);
  expect(text).not.toMatch(FORBIDDEN);
});

test('search narrows the list', async ({ page }) => {
  await page.goto('/swarms?q=lean');
  await expect(page.locator('#swarms').getByRole('heading', { level: 3 })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Challenge Vaults' })).toBeVisible();
});

test('swarm page opens the app through a navigate-only deep link', async ({ page }) => {
  await page.goto('/swarms/verafy-dao-juries');
  await expect(page.getByRole('link', { name: 'Open in Henge' })).toHaveAttribute('href', 'henge://swarm/verafy-dao-juries');
  await expect(page.getByText('12 credits per accepted task')).toBeVisible();
  await expect(page.getByText('Pool empty: no paid tasks until the publisher funds it.')).toBeVisible();
  await expect(page.getByText('Not enough history yet')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/[–—]/);
});

test('swarm page answers the six questions in source order (M4 acceptance, SPEC 4.2)', async ({ page }) => {
  await page.goto('/swarms/challenge-vaults');
  await expect(page.locator('[data-question] h2')).toHaveText([
    'What is it for, and who runs it?',
    'What has it produced?',
    'What does it need from your computer?',
    'What does it pay, and how often is work accepted?',
    'How is work checked?',
    'Can you trust it?',
  ]);
  await expect(page.locator('[data-question="requirements"]')).toContainText('No network access');
});

test('unknown swarm is a 404 page', async ({ page }) => {
  const res = await page.goto('/swarms/does-not-exist');
  expect(res?.status()).toBe(404);
});

test('models page renders', async ({ page }) => {
  await page.goto('/models');
  await expect(page.getByRole('heading', { name: 'Phi-4 14B' })).toBeVisible();
  await expect(page.getByText('phi4:14b-q4_K_M')).toBeVisible();
});

test('the Henge web header links to the store, which moved to /swarms', async ({ page }) => {
  await page.goto('/models');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Swarms' })).toHaveAttribute('href', '/swarms');
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in to Henge web');
});

test('the /v1 API answers with contracts and the error envelope', async ({ request }) => {
  expect(await (await request.get('/v1/health')).json()).toEqual({ ok: true, version: 'v1' });
  const list = await request.get('/v1/swarms');
  expect(list.headers()['access-control-allow-origin']).toBe('*');
  expect((await list.json()).items).toHaveLength(3);
  const planned = await request.post('/v1/jobs');
  expect(planned.status()).toBe(501);
  expect((await planned.json()).error.code).toBe('not_implemented');
  // The verification endpoints are live (M6): unsigned verifiers and anonymous wallets are refused.
  expect((await request.post('/v1/verifications', { data: {} })).status()).toBe(401);
  expect((await request.get('/v1/verifier/work')).status()).toBe(401);
  expect((await request.get('/v1/wallet')).status()).toBe(401);
  expect((await request.get('/api/v1/health')).status()).toBe(404);
  // The lease endpoints are live (M5) and refuse unsigned callers.
  expect((await request.post('/v1/coordinators/challenge-vaults/leases', { data: {} })).status()).toBe(401);
});

test('public results show settled work only, with counts, and anyone can fetch the receipt keys (M7)', async ({ page, request }) => {
  await page.goto('/swarms/challenge-vaults');
  await page.getByRole('link', { name: 'See verified results' }).click();
  await expect(page).toHaveURL(/\/swarms\/challenge-vaults\/results$/);
  await expect(page.getByRole('heading', { name: 'Verified results' })).toBeVisible();
  await expect(page.getByTestId('counts-settled')).toHaveText(/^\d+$/);
  const api = await request.get('/v1/swarms/challenge-vaults/results');
  expect(api.status()).toBe(200);
  const body = await api.json();
  expect(Object.keys(body.counts).sort()).toEqual(['impact_settled', 'in_verification', 'pending', 'rejected', 'settled']);
  await expect(page.getByTestId('public-result')).toHaveCount(body.items.length);
  expect((await request.get('/v1/swarms/does-not-exist/results')).status()).toBe(404);
  expect((await request.get('/v1/results/00000000-0000-7000-8000-000000000000')).status()).toBe(404);
  const keys = await (await request.get('/v1/receipts/keys')).json();
  expect(keys.keys.length).toBeGreaterThan(0);
  // A receipt is the contributor's own; the kill switch is for admins.
  expect((await request.get('/v1/me/results/00000000-0000-7000-8000-000000000000/receipt')).status()).toBe(401);
  expect((await request.post('/v1/admin/revocations', { data: {} })).status()).toBe(401);
  const feed = await (await request.get('/v1/revocations')).json();
  expect(Array.isArray(feed.keys)).toBe(true);
});
