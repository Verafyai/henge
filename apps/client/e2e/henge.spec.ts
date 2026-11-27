/**
 * Henge layout flows (spin-out spec v2, 9.1 and 9.2), behind HENGE_COMMUNITY_LAYOUT. Runs the built app
 * with a throwaway profile and a test-only keychain service against the same website the client suite
 * starts (playwright.config.ts). Community data (profiles, messages, proposals, moderation) is the
 * in-memory CommunityStore; `.henge` files are resolved and stored by the main process.
 *
 * The example Henge is served through a file:// URL, which only unpackaged test runs accept
 * (HENGE_TEST_FILE_URLS); real links must be https on public addresses.
 *
 * Set HENGE_SHOTS_DIR to also save a 1440x900 screenshot of each flow there.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const API = 'http://localhost:3000';
const SERVICE = `ai.verafy.henge.e2e-layout.${process.pid}`;
const PROFILE = mkdtempSync(path.join(tmpdir(), 'henge-layout-e2e-'));
const EXAMPLE = pathToFileURL(path.resolve(__dirname, '../../../packages/schema/fixtures/henge/valid/example.henge.yaml')).href;
const SHOTS = process.env['HENGE_SHOTS_DIR'] ?? '';
const KEYRING = require.resolve('@napi-rs/keyring');

let app: ElectronApplication;
let page: Page;

async function shot(name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(1, 1); // No hover states in the pictures.
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), scale: 'css' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${PROFILE}`],
    env: {
      ...process.env,
      SWARM_EXPLORER_API_URL: API,
      ELECTRON_RENDERER_URL: '',
      SWARM_EXPLORER_KEYCHAIN_SERVICE: SERVICE,
      SWARM_EXPLORER_HARDWARE_FIXTURE: 'apple-silicon-32gb',
      HENGE_COMMUNITY_LAYOUT: '1',
      HENGE_TEST_FILE_URLS: '1',
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
});

test.afterAll(async () => {
  await app
    ?.evaluate(
      async (_e, a) => {
        const { createRequire } = process.getBuiltinModule('node:module');
        const { Entry } = createRequire(a.mod)(a.mod) as typeof import('@napi-rs/keyring');
        for (const n of ['session', 'device-key', 'cache-key']) {
          try {
            new Entry(a.service, n).deletePassword();
          } catch {
            // Not present.
          }
        }
      },
      { mod: KEYRING, service: SERVICE },
    )
    .catch(() => undefined);
  await app?.close().catch(() => undefined);
  rmSync(PROFILE, { recursive: true, force: true });
});

test('sign in screen offers GitHub, shows email as Later, and runs locally without an account', async () => {
  await expect(page.getByRole('heading', { name: 'Welcome to Henge' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with GitHub/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Continue with email/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Continue with email/ })).toContainText('Later');
  await shot('07-sign-in');
  await page.getByRole('button', { name: 'Run locally without an account' }).click();
});

test('empty state: only the Henge mark and + on the rail, with join and create', async () => {
  await expect(page.getByRole('heading', { name: 'Add your first Henge' })).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Henges' });
  await expect(rail.getByRole('button', { name: 'Home' })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Add a Henge' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Join with a .henge link/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a Henge' })).toBeVisible();
  await shot('02-empty-state');
});

test('join the example Henge from a pasted .henge URL: rules gate Accept, participation needs the daily cap', async () => {
  await page.getByRole('button', { name: /Join with a .henge link/ }).click();
  await page.getByLabel('Henge link').fill(EXAMPLE);
  await page.getByRole('button', { name: 'Open link' }).click();
  await expect(page.getByRole('heading', { name: 'Resolved Forecasts (example)' })).toBeVisible();
  const accept = page.getByRole('button', { name: 'Accept invite' });
  const rules = page.getByRole('checkbox');
  await expect(rules).toHaveCount(2); // admission.requirements.attest in the example file.
  await expect(accept).toBeDisabled();
  await rules.nth(0).check();
  await expect(accept).toBeDisabled();
  await rules.nth(1).check();
  await expect(accept).toBeEnabled();
  await shot('03-invite-join');
  await accept.click();

  await expect(page.getByRole('heading', { name: 'How should your agent take part?' })).toBeVisible();
  const join = page.getByRole('button', { name: 'Join Resolved Forecasts' });
  await expect(join).toBeDisabled(); // budget.daily_cap.required in the file.
  await page.getByLabel('Daily cap').fill('5');
  await expect(join).toBeEnabled();
  await shot('04-participation');
  await join.click();

  // The main view: channels from the file, and its Glyphs.
  await expect(page.getByRole('main', { name: '#general' })).toBeVisible();
  await expect(page.getByPlaceholder('Message #general, or type / for Glyph commands')).toHaveCount(0); // Signed out: chat needs an account.
  const column = page.getByRole('complementary', { name: 'Resolved Forecasts (example) channels' });
  for (const c of ['welcome', 'general', 'tasks', 'results', 'proposals']) await expect(column.getByRole('button', { name: new RegExp(`\\b${c}$`) })).toBeVisible();
  const glyphs = page.getByRole('group', { name: 'Glyphs' });
  for (const g of ['Governance', 'Benchmark', 'Learnings', 'Strategy', 'Treasury', 'Moderation']) await expect(glyphs.getByRole('button', { name: g, exact: true })).toBeVisible();
  await expect(page.getByTestId('pinned-card')).toContainText('v0.1.0');
  // The run rules follow the participation step: "Idle" is the default schedule.
  const o = await page.evaluate(() => window.swarm.node.overview());
  expect(o.rules.when.kind).toBe('idle');
});

test('sign in, then set up a profile with a live handle check and link the agent', async () => {
  await app.evaluate(({ shell }) => {
    (globalThis as Record<string, unknown>).__opened = null;
    shell.openExternal = async (u: string) => {
      (globalThis as Record<string, unknown>).__opened = u;
    };
  });
  await page.getByRole('status', { name: 'Node status' }).getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__opened)).toBeTruthy();
  const url = (await app.evaluate(() => (globalThis as Record<string, unknown>).__opened)) as string;
  const browser = await chromium.launch();
  const web = await browser.newPage();
  await web.goto(url);
  await web.getByRole('button', { name: /Demo Contributor/ }).click();
  await web.getByRole('button', { name: 'Continue to the client' }).click();
  await expect(web.getByRole('heading', { name: 'You are signed in' })).toBeVisible();
  await browser.close();

  await expect(page.getByRole('heading', { name: 'Set up your profile' })).toBeVisible();
  const handle = page.getByLabel('Handle');
  await handle.fill('admin');
  await expect(page.getByTestId('handle-availability')).toContainText(/reserved|taken/i);
  await handle.fill('demo');
  await expect(page.getByTestId('handle-availability')).toContainText(/available/i);
  await page.getByLabel('Display name').fill('Demo Contributor');
  await page.getByLabel(/^Bio/).fill('Forecasting on weekends.');
  await shot('14-profile-setup');
  await page.getByRole('button', { name: 'Next: link your agent' }).click();
  await expect(page.getByRole('heading', { name: /link your agent/i })).toBeVisible();
  await page.getByRole('button', { name: 'Link agent and finish' }).click();
  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('demo');
});

test('send a message in #general; the four columns are filled from real data', async () => {
  await page.getByRole('navigation', { name: 'Henges' }).getByRole('button', { name: /Resolved Forecasts/ }).click();
  const box = page.getByPlaceholder('Message #general, or type / for Glyph commands');
  await expect(box).toBeVisible();
  await box.fill('Hello from **this** node. Scores land in #results.');
  await box.press('Enter');
  const msg = page.getByTestId('message').filter({ hasText: 'Hello from this node' });
  await expect(msg).toBeVisible();
  await expect(msg.locator('b')).toHaveText('this'); // The markdown subset renders bold.
  const members = page.getByRole('complementary', { name: 'Members' });
  await expect(members.getByRole('button', { name: /^demo, human/ })).toBeVisible();
  await expect(members.getByRole('button', { name: /local-node, agent/ })).toBeVisible();
  await shot('01-client-main');

  // A thread on the message (13: community chat).
  await msg.hover();
  await msg.getByRole('button', { name: 'Reply in thread' }).click();
  const thread = page.getByRole('complementary', { name: 'Thread' });
  await thread.getByRole('textbox').fill('Following up in a thread.');
  await thread.getByRole('textbox').press('Enter');
  await expect(thread.getByText('Following up in a thread.')).toBeVisible();
  await shot('13-community-chat');
  await thread.getByRole('button', { name: 'Close thread' }).click();
});

test('profile popover from the member list', async () => {
  await page.getByRole('complementary', { name: 'Members' }).getByRole('button', { name: /^demo, human/ }).click();
  const pop = page.getByRole('dialog', { name: 'Profile of demo' });
  await expect(pop).toContainText('Demo Contributor');
  await expect(pop).toContainText('Forecasting on weekends.');
  await shot('15-profile-popover');
  await page.keyboard.press('Escape');
  await expect(pop).toHaveCount(0);
});

test('Add a Glyph in the joined example lists the Glyphs it already has', async () => {
  await page.getByRole('group', { name: 'Glyphs' }).getByRole('button', { name: 'Add a Glyph' }).click();
  const modal = page.getByRole('dialog', { name: 'Add a Glyph' });
  await expect(modal.getByRole('option', { name: /Treasury Glyph/ })).toContainText('added');
  await shot('05-add-a-glyph');
  await modal.getByRole('button', { name: 'Close' }).click();
});

test('create a Henge: template, name, channels, Governance and Moderation preselected, stored locally', async () => {
  await page.getByRole('navigation', { name: 'Henges' }).getByRole('button', { name: 'Add a Henge' }).click();
  await page.getByRole('menuitem', { name: 'Create a Henge' }).click();
  await expect(page.getByRole('heading', { name: 'Create a Henge' })).toBeVisible();
  const glyphs = page.getByRole('group', { name: 'Default Glyphs' });
  await expect(glyphs.getByRole('checkbox', { name: 'Governance Glyph' })).toBeChecked();
  await expect(glyphs.getByRole('checkbox', { name: 'Moderation Glyph' })).toBeChecked();
  await expect(page.getByRole('radiogroup', { name: 'Storage' })).toContainText('Later');
  await page.getByLabel('Name', { exact: true }).fill('Night Owls');
  await shot('18-create-henge');
  await page.getByRole('button', { name: 'Create Henge' }).click();
  await expect(page.getByRole('main', { name: '#general' })).toBeVisible();
  await expect(page.getByTestId('pinned-card')).toContainText('You created this Henge. Stored on this computer.');
});

test('Add a Glyph refuses a grant wider than the manifest requests, then adds it', async () => {
  await page.getByRole('group', { name: 'Glyphs' }).getByRole('button', { name: 'Add a Glyph' }).click();
  const modal = page.getByRole('dialog', { name: 'Add a Glyph' });
  await modal.getByRole('option', { name: /Benchmark Glyph/ }).click();
  await expect(modal.getByText('This Glyph will be able to')).toBeVisible();
  await expect(modal.getByText('It cannot')).toBeVisible();
  const add = modal.getByRole('button', { name: 'Add a Glyph', exact: true });
  await expect(add).toBeEnabled();
  await modal.getByLabel('Grant another scope').fill('treasury:pay');
  await modal.getByRole('button', { name: 'Grant', exact: true }).click();
  await expect(modal.getByRole('alert').first()).toContainText(/not request|requests/i);
  await expect(add).toBeDisabled();
  await modal.getByText('Pay credits from the shared pool').click();
  await expect(modal.getByRole('checkbox', { name: 'Pay credits from the shared pool' })).toHaveCount(0); // An extra scope disappears once ungranted.
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByRole('heading', { name: 'Benchmark Glyph' })).toBeVisible();
});

test('a vote-gated Rune change opens a proposal in #proposals instead of applying', async () => {
  const nav = page.getByRole('navigation', { name: 'Henge settings' });
  await nav.getByRole('button', { name: 'Governance Glyph' }).click();
  await expect(page.getByRole('heading', { name: 'Governance Glyph' })).toBeVisible();
  const rune = page.getByRole('group', { name: 'Rune Voting method' });
  await expect(rune).toContainText('Changing this Rune needs a member vote.');
  await rune.getByRole('radio', { name: 'Supermajority', exact: true }).click();
  await expect(page.getByTestId('rune-bar')).toHaveText('1 Rune change will open a proposal in #proposals.');
  await shot('06-glyph-runes');
  await page.getByRole('button', { name: 'Propose changes' }).click();
  await expect(page.getByTestId('rune-status')).toContainText('Proposal #1 opened in #proposals');
  // Nothing changed in the file: the Rune still shows its old value.
  await expect(rune.getByRole('radio', { name: 'Majority', exact: true })).toBeChecked();
  await page.getByTestId('rune-status').getByRole('button', { name: 'Open #proposals' }).click();
  const p = page.getByTestId('proposal');
  await expect(p).toContainText('PROPOSAL #1');
  await expect(p.getByRole('list', { name: 'Proposed changes' })).toContainText('supermajority');
});

test('channel settings: the permission matrix covers the Henge roles', async () => {
  await page.getByRole('button', { name: 'Night Owls menu' }).click();
  await page.getByRole('menuitem', { name: 'Channel settings' }).click();
  const matrix = page.getByRole('table', { name: 'Channel permissions' });
  await expect(matrix).toBeVisible();
  for (const r of ['owner', 'maintainer', 'member', 'agent']) await expect(matrix.getByRole('columnheader', { name: r, exact: true })).toBeVisible();
  const cell = matrix.getByRole('button', { name: 'Send messages for agent: Henge default' });
  await cell.click();
  await expect(matrix.getByRole('button', { name: 'Send messages for agent: allow' })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot('16-channel-settings');
  await page.getByRole('button', { name: 'Close settings' }).click();
});

test('moderation: mod tools act on a member and every action lands in the audit log', async () => {
  // Reports need a second author, which only the community service provides; memory.test.ts covers them.
  await page.getByRole('button', { name: 'Night Owls menu' }).click();
  await page.getByRole('menuitem', { name: 'Moderation' }).click();
  const tools = page.getByRole('complementary', { name: 'Mod tools' });
  await expect(tools.getByLabel('Member')).toContainText('demo/local-node'); // Your agent is its own actor.
  await expect(tools).toContainText('No open reports.');
  await tools.getByLabel('Reason').fill('Testing the audit log.');
  await tools.getByRole('button', { name: /Timeout/ }).click();
  await tools.getByRole('button', { name: /Revoke agent API token/ }).click();
  const log = page.getByRole('list', { name: 'Audit log' });
  await expect(log.getByRole('listitem')).toHaveCount(3); // Including the channel settings saved above.
  await expect(log).toContainText('timed out');
  await expect(log).toContainText('revoked the API token of');
  await expect(log).toContainText('Testing the audit log.');
  await shot('17-mod-audit-log');
});

test('renderer copy has no dashes or retired names on the screens above', async () => {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/[–—]/);
  expect(text).not.toMatch(/\bplugins?\b|\bbots?\b|Swarm Explorer/i);
});
