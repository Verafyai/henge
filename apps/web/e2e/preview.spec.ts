import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { pasteLink } from '../lib/henge-landing-copy';
import { EXAMPLE_PATH, preview } from '../lib/henge-preview-copy';

/**
 * /s?url= link preview (spin-out spec v2, 5.5 B5): renders the example served by the e2e server
 * itself (http://localhost is allowed only because playwright.config.ts sets the test-only
 * HENGE_PREVIEW_ALLOW_LOCALHOST flag), and refuses http, private addresses and oversize files.
 */

let side: http.Server;
let sidePort = 0;
test.beforeAll(async () => {
  // A second local server for files the app must refuse. It listens on loopback only.
  side = http.createServer((req, res) => {
    if (req.url === '/big.henge') {
      res.writeHead(200, { 'content-type': 'application/yaml' });
      res.end(Buffer.alloc(300 * 1024, 0x61));
    } else if (req.url === '/bad.henge') {
      res.writeHead(200, { 'content-type': 'application/yaml' });
      res.end('henge: "1.0"\nkind: swarm\nid: Not A Valid Id\n');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => side.listen(0, '127.0.0.1', () => r()));
  sidePort = (side.address() as AddressInfo).port;
});
test.afterAll(() => new Promise<void>((r) => side.close(() => r())));

const sUrl = (u: string) => `/s?url=${encodeURIComponent(u)}`;

async function noHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, 'page scrolls sideways').toBeLessThanOrEqual(client);
}

test('the example .henge file is served from public/', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}${EXAMPLE_PATH}`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain('id: example-org/resolved-forecasts');
});

test('/s: "Try the example" renders the Henge landing page from its .henge file', async ({ page, baseURL }) => {
  const exampleUrl = `${baseURL}${EXAMPLE_PATH}`;
  await page.goto('/s');
  await page.getByRole('link', { name: preview.tryExample }).click();
  await expect(page).toHaveURL(new RegExp(`/s\\?url=${encodeURIComponent(exampleUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const card = page.locator('article.hg-pv');
  await expect(card.getByRole('heading', { level: 2, name: 'Resolved Forecasts' })).toBeVisible();
  await expect(card.getByText('Forecast the past, blind. Get scored on what actually happened.')).toBeVisible();
  await expect(card.getByRole('heading', { name: 'What you do' })).toBeVisible();
  await expect(card.getByRole('heading', { name: 'How it is scored' })).toBeVisible();
  await expect(card.getByText(preview.admission.modes.request)).toBeVisible();
  await expect(card.getByText('I will not look up the outcome of a question while answering it.')).toBeVisible();
  for (const g of ['verafy/governance@^1.0.0', 'verafy/benchmark@^1.0.0', 'verafy/learnings@^1.0.0']) await expect(card.getByText(g, { exact: true })).toBeVisible();
  await expect(page.getByTestId('pv-source-url')).toHaveText(exampleUrl);
  await expect(page.getByTestId('pv-digest')).toHaveText(/^sha256-[0-9a-f]{64}$/);
  await expect(card.getByRole('link', { name: preview.openInHenge })).toHaveAttribute('href', `henge://add?url=${encodeURIComponent(exampleUrl)}`);
  // The accent from the file is applied, and the page has no dashes the copy rules forbid.
  expect(await card.evaluate((el) => getComputedStyle(el).getPropertyValue('--hg-pv-accent').trim())).toBe('#FF2A3D');
  expect(await page.locator('body').innerText()).not.toMatch(/[–—]/);
});

test('/s: pasting a link into the field and submitting renders it', async ({ page, baseURL }) => {
  await page.goto('/s');
  await page.getByLabel(pasteLink.label).fill(`${baseURL}${EXAMPLE_PATH}`);
  await page.getByRole('button', { name: preview.submit }).click();
  await expect(page.locator('article.hg-pv').getByRole('heading', { level: 2, name: 'Resolved Forecasts' })).toBeVisible();
  await expect(page.getByLabel(pasteLink.label)).toHaveValue(`${baseURL}${EXAMPLE_PATH}`);
});

test('/s refuses http, private addresses, oversize and invalid files, calmly and specifically', async ({ page }) => {
  const cases: [string, keyof typeof preview.errors][] = [
    ['http://example.org/a.henge', 'not_https'],
    ['https://10.0.0.1/a.henge', 'private_address'],
    ['https://192.168.1.20/a.henge', 'private_address'],
    ['https://[::1]/a.henge', 'private_address'],
    [`http://localhost:${sidePort}/big.henge`, 'too_large'],
    [`http://localhost:${sidePort}/bad.henge`, 'invalid'],
  ];
  for (const [u, kind] of cases) {
    const res = await page.goto(sUrl(u));
    expect(res?.status(), u).toBe(200);
    const alert = page.locator('.hg-pv-error');
    await expect(alert, u).toHaveAttribute('data-error', kind);
    const e = preview.errors[kind] as { title: string };
    await expect(alert.getByRole('heading', { name: e.title })).toBeVisible();
    await expect(page.locator('article.hg-pv')).toHaveCount(0);
  }
  // Invalid files list the first validation messages.
  await page.goto(sUrl(`http://localhost:${sidePort}/bad.henge`));
  expect(await page.locator('.hg-pv-issues li').count()).toBeGreaterThan(0);
  await page.goto(sUrl(`http://localhost:${sidePort}/big.henge`));
  await expect(page.getByText('Caps: 256 KB for the .henge file')).toBeVisible();
});

test('/s with the example has no horizontal scroll at 390px', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sUrl(`${baseURL}${EXAMPLE_PATH}`));
  await expect(page.locator('article.hg-pv')).toBeVisible();
  await noHorizontalScroll(page);
});

test('JSON Schemas are published with application/schema+json and a long cache', async ({ request, baseURL }) => {
  for (const name of ['henge-v1', 'glyph-v1']) {
    const res = await request.get(`${baseURL}/schema/${name}.json`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/schema+json');
    expect(res.headers()['cache-control']).toMatch(/max-age=\d{5,}/);
    const body = (await res.json()) as { $id: string };
    expect(body.$id).toBe(`https://henge.verafy.ai/schema/${name}.json`);
  }
});

/** Screenshots for the PR, only when PREVIEW_SHOTS_DIR is set. */
const shots = process.env.PREVIEW_SHOTS_DIR;
for (const s of [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
]) {
  test(`screenshots of /s with the example at ${s.name}`, async ({ page, baseURL }) => {
    test.skip(!shots, 'set PREVIEW_SHOTS_DIR to take screenshots');
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.goto(sUrl(`${baseURL}${EXAMPLE_PATH}`));
    await expect(page.locator('article.hg-pv')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(shots!, `s-example-${s.name}.png`) });
    await page.screenshot({ path: path.join(shots!, `s-example-${s.name}-full.png`), fullPage: true });
  });
}
