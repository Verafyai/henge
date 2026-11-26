/**
 * Desktop client acceptance (SPEC 16.4 M0 to M4). Runs the built app against the website API with
 * a throwaway profile, a test-only keychain service, fixture hardware and a stand-in Ollama on
 * loopback. M1 acceptance: the renderer has no Node or key access, and first run detects fixtures
 * and selects Local on qualifying fixtures. M2 acceptance: hash mismatch is blocked, fit states and
 * the benchmark are recorded, and the active model is never evicted. M3 acceptance (in-app self-check
 * against the real proxy): a harness cannot read keys, files or unlisted domains; limits end the
 * task; prompt-injection checks pass. M4 acceptance: the six swarm-page questions appear in order; a
 * permission change requires consent again; leave cancels immediately. M5: a qualified node leases
 * a seeded task only when its run rules allow, runs it in the sandbox on the stand-in model and
 * submits a device-signed result; Pause mid-task cancels the model call and returns the task to the
 * queue unpaid. Idle time and power come from a sensor fixture file (unpackaged test hook).
 * Needs: `pnpm db:reset`, `pnpm --filter @swarm-explorer/client release:test`,
 * a website build, and `pnpm --filter @swarm-explorer/client build`.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { proxySocketDir } from '../src/main/socket-path';
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const API = 'http://localhost:3000';
const SERVICE = `ai.verafy.henge.e2e.${process.pid}`;
const PROFILE = mkdtempSync(path.join(tmpdir(), 'se-client-e2e-'));
// What the run rules "see": the app rereads this file on every check (SWARM_EXPLORER_SENSOR_FIXTURE).
const SENSOR_DIR = mkdtempSync(path.join(tmpdir(), 'se-client-e2e-sensors-'));
const SENSORS = path.join(SENSOR_DIR, 'sensors.json');
const setSensors = (o: { idleSeconds: number; onBattery: boolean }) => writeFileSync(SENSORS, JSON.stringify(o));
// Someone is using the computer, so the default "only when idle" rule holds tasks back.
setSensors({ idleSeconds: 0, onBattery: false });

// Seeded catalog hashes are fixture digests (packages/db seed): sha256 of a fixture string.
const seededDigest = (slug: string, version: string) => createHash('sha256').update(`fixture-artifact:${slug}:${version}`).digest('hex');
// What the stand-in Ollama "pulls": the pinned digest for the coder model, a drifted one for Mistral.
const PULLS: Record<string, string> = {
  'qwen2.5-coder:7b-instruct-q4_K_M': seededDigest('qwen2.5-coder-7b', '7b-instruct-q4_K_M'),
  'mistral-small:24b-instruct-2501-q4_K_M': 'd'.repeat(64),
};

// A stand-in Ollama. Discovery must only ever use GET; pulls, deletes and benchmarks happen only
// after a confirmed download.
const ollamaCalls: string[] = [];
type ChatBody = { model: string; options: { num_predict: number }; messages: Array<{ role: string; content: string }> };
const chatBodies: ChatBody[] = [];
// Known-answer tasks get a JSON answer; the delay lets a test leave or pause while a task is running.
// `delays` is used first, one entry per task call; then `delayMs`.
const chat = { answer: '{"reproduced":false,"attack":null}', delayMs: 0, delays: [] as number[] };
// Task calls whose caller hung up before the answer: a cancelled model call.
const chatAborted: ChatBody[] = [];
const isTaskCall = (b: ChatBody) => b.messages.some((m) => m.role === 'user' && m.content.startsWith('Task input as quoted JSON data.'));
const ollamaTags = [
  { name: 'qwen2.5-coder:7b', digest: 'a'.repeat(64), size: 4683087332 },
  { name: 'llama3.1:8b', digest: 'b'.repeat(64), size: 4920753328 },
];
const ollama: Server = createServer((req, res) => {
  ollamaCalls.push(`${req.method} ${req.url}`);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.method === 'GET' && req.url === '/api/version') return void j({ version: '0.12.3' });
    if (req.method === 'GET' && req.url === '/api/tags') return void j({ models: ollamaTags });
    if (req.method === 'POST' && req.url === '/api/pull') {
      const { model } = JSON.parse(body) as { model: string };
      if (!PULLS[model]) return void j({ error: 'not found' });
      ollamaTags.push({ name: model, digest: PULLS[model], size: 1 });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      return void res.end('{"status":"pulling manifest"}\n{"status":"downloading","total":1000,"completed":500}\n{"status":"success","total":1000,"completed":1000}\n');
    }
    if (req.method === 'DELETE' && req.url === '/api/delete') {
      const { model } = JSON.parse(body) as { model: string };
      const i = ollamaTags.findIndex((t) => t.name === model);
      if (i >= 0) ollamaTags.splice(i, 1);
      return void res.writeHead(200).end();
    }
    if (req.method === 'POST' && req.url === '/api/generate') return void j({ eval_count: 64, eval_duration: 2_000_000_000 });
    if (req.method === 'POST' && req.url === '/api/chat') {
      const b = JSON.parse(body) as ChatBody;
      chatBodies.push(b);
      if (!isTaskCall(b)) return void j({ message: { role: 'assistant', content: 'OK' }, eval_count: 1, prompt_eval_count: 5 });
      const timer = setTimeout(() => j({ message: { role: 'assistant', content: chat.answer }, eval_count: 12, prompt_eval_count: 40 }), chat.delays.shift() ?? chat.delayMs);
      res.on('close', () => {
        if (res.writableEnded) return;
        clearTimeout(timer);
        chatAborted.push(b);
      });
      return;
    }
    res.writeHead(404).end();
  });
});
let ollamaHost = '';

// A stand-in Hugging Face that serves bytes which do not match the pinned GGUF hash.
const hfCalls: string[] = [];
const hf: Server = createServer((req, res) => {
  hfCalls.push(`${req.method} ${req.url}`);
  res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(Buffer.from('not the pinned gguf bytes'));
});
let hfBase = '';

// llama.cpp "installed": a stub on PATH that is found but never run (discovery does not execute it).
const BIN = mkdtempSync(path.join(tmpdir(), 'se-client-e2e-bin-'));
writeFileSync(path.join(BIN, 'llama-server'), '#!/bin/sh\nexit 1\n');
chmodSync(path.join(BIN, 'llama-server'), 0o755);

async function launch(opts: { args?: string[]; api?: string; fixture?: string; profile?: string } = {}) {
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${opts.profile ?? PROFILE}`, ...(opts.args ?? [])],
    env: {
      ...process.env,
      SWARM_EXPLORER_API_URL: opts.api ?? API,
      ELECTRON_RENDERER_URL: '',
      SWARM_EXPLORER_KEYCHAIN_SERVICE: SERVICE,
      SWARM_EXPLORER_HARDWARE_FIXTURE: opts.fixture ?? 'apple-silicon-32gb',
      SWARM_EXPLORER_OLLAMA_HOST: ollamaHost,
      SWARM_EXPLORER_HF_BASE: hfBase,
      SWARM_EXPLORER_SENSOR_FIXTURE: SENSORS,
      PATH: `${BIN}${path.delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

// Keychain items are readable without a prompt only by the binary that created them (the Electron
// app), so reads and cleanup run inside the app's main process, never in the test runner.
const KEYRING = require.resolve('@napi-rs/keyring');
type KeyName = 'session' | 'device-key' | 'cache-key';

async function keychain(name: KeyName): Promise<string | null> {
  return app.evaluate(
    async (_e, a) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const { Entry } = createRequire(a.mod)(a.mod) as typeof import('@napi-rs/keyring');
      return new Entry(a.service, a.name).getPassword() ?? null;
    },
    { mod: KEYRING, service: SERVICE, name },
  );
}

async function clearKeychain() {
  await app.evaluate(
    async (_e, a) => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const { Entry } = createRequire(a.mod)(a.mod) as typeof import('@napi-rs/keyring');
      for (const n of a.names) {
        try {
          new Entry(a.service, n).deletePassword();
        } catch {
          // Not present.
        }
      }
    },
    { mod: KEYRING, service: SERVICE, names: ['session', 'device-key', 'cache-key'] },
  );
}

/** Every regular file the app wrote to its profile directory (Chromium's Singleton* entries are symlinks). */
function profileFiles(dir = PROFILE): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return []; // Removed while we walked.
    }
    if (st.isDirectory()) return profileFiles(p);
    return st.isFile() ? [p] : [];
  });
}

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  ollamaHost = `127.0.0.1:${(ollama.address() as { port: number }).port}`;
  await new Promise<void>((r) => hf.listen(0, '127.0.0.1', r));
  hfBase = `http://127.0.0.1:${(hf.address() as { port: number }).port}`;
  ({ app, page } = await launch());
});

test.afterAll(async () => {
  await clearKeychain().catch(() => undefined);
  await app?.close().catch(() => undefined);
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(SENSOR_DIR, { recursive: true, force: true });
  ollama.close();
  hf.close();
  rmSync(BIN, { recursive: true, force: true });
});

/**
 * Opens the account menu and waits until it says it is open. A click that lands while the header is still settling
 * after sign in is retried; a menu that never opens still fails the test.
 */
async function openAccountMenu() {
  const button = page.getByRole('button', { name: 'Account menu' });
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

test('every window uses the hardened webPreferences (SPEC 11.1)', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => {
      // Effective preferences as Electron applied them. Undeclared in electron.d.ts but present
      // at runtime; if it ever disappears this throws and the test fails rather than passing vacuously.
      const wc = w.webContents as typeof w.webContents & { getLastWebPreferences(): Record<string, unknown> };
      const p = wc.getLastWebPreferences();
      return {
        contextIsolation: p.contextIsolation,
        sandbox: p.sandbox,
        nodeIntegration: p.nodeIntegration,
        nodeIntegrationInWorker: p.nodeIntegrationInWorker,
        nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
        webSecurity: p.webSecurity,
        allowRunningInsecureContent: p.allowRunningInsecureContent,
        webviewTag: p.webviewTag,
      };
    }),
  );
  expect(prefs.length).toBeGreaterThan(0);
  for (const p of prefs) {
    expect(p).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  }
});

test('the renderer is served from app:// with no Node access and only named bridge methods', async () => {
  expect(page.url()).toBe('app://henge/index.html');
  const probe = await page.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    bridge: Object.keys(window.swarm).sort(),
  }));
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    bridge: ['account', 'auth', 'getAppInfo', 'models', 'node', 'onNavigate', 'onNotice', 'openExternal', 'recent', 'swarms', 'takeLaunchRoute', 'updates'],
  });
  // The node bridge hands over facts and choices only: nothing key-like crosses it.
  const overview = await page.evaluate(() => window.swarm.node.overview());
  expect(JSON.stringify(overview)).not.toMatch(/PRIVATE KEY|sxa_|sxr_|refresh/i);
  const refused = await page.evaluate(async () =>
    Promise.all(['file:///etc/passwd', 'https://evil.example/', 'http://github.com/'].map((u) => window.swarm.openExternal(u))),
  );
  expect(refused).toEqual([false, false, false]);
  // The renderer cannot approve permissions the app never showed for review.
  const approve = await page.evaluate(() => window.swarm.swarms.approve('00000000-0000-7000-8000-000000000000', `sha256-${'0'.repeat(64)}`));
  expect(approve).toMatchObject({ ok: false, code: 'review_first' });
});

test('the node supervisor runs as its own utility process (SPEC 11.2)', async () => {
  const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? m.serviceName ?? '' })));
  expect(procs).toContainEqual(expect.objectContaining({ type: 'Utility', name: 'Henge node supervisor' }));
});

test('the model proxy is its own process on a private socket, not a TCP port (SPEC 11.2)', async () => {
  const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => m.name ?? ''));
  expect(procs).toContain('Henge model proxy');
  const run = proxySocketDir(await app.evaluate(({ app }) => app.getPath('userData')));
  await expect.poll(() => (existsSync(run) ? readdirSync(run).filter((f) => f.endsWith('.sock')).length : 0)).toBe(1);
  expect(lstatSync(run).mode & 0o777).toBe(0o700);
  const sock = readdirSync(run).find((f) => f.endsWith('.sock'))!;
  expect(lstatSync(path.join(run, sock)).isSocket()).toBe(true);
  expect(lstatSync(path.join(run, sock)).mode & 0o077).toBe(0);
});

test('first run opens Pick a cause, detects the fixture and preselects Local (M1 acceptance)', async () => {
  await expect(page.getByRole('heading', { name: 'Pick a cause', level: 1 })).toBeVisible();
  const causes = page.getByRole('region', { name: 'Causes' });
  await expect(causes.getByRole('button', { name: /Gaming/ })).toBeDisabled(); // No listed swarm: coming soon, not invented.
  await causes.getByRole('button', { name: /Governance/ }).click();
  const featured = page.getByRole('region', { name: 'Featured cause' });
  await expect(featured.getByRole('heading', { name: 'Verafy DAO juries' })).toBeVisible();
  await featured.getByRole('button', { name: 'Choose this cause' }).click();

  const computer = page.getByRole('region', { name: 'Your computer' });
  await expect(computer).toContainText('Test fixture: apple-silicon-32gb');
  await expect(computer).toContainText('Apple M3 Pro (unified memory)');
  await expect(computer.getByRole('list', { name: 'Model runtimes' })).toContainText('Ollama: found (0.12.3), 2 models installed');
  await expect(computer.getByRole('status', { name: 'Fit' })).toContainText('This computer can run a qualifying local model');
  expect(ollamaCalls.every((c) => c.startsWith('GET '))).toBe(true);

  const modes = page.getByRole('group', { name: 'Compute mode' });
  await expect(modes.getByRole('radio', { name: 'Local', exact: true })).toBeChecked();
  await expect(modes.getByRole('radio', { name: 'API key', exact: true })).toBeDisabled();
  await expect(modes.getByRole('radio', { name: 'Hybrid', exact: true })).toBeDisabled();
  await expect(modes).toContainText('Off until provider terms are reviewed.');

  const rules = page.getByRole('table', { name: 'Run rules' });
  await expect(rules.getByRole('row', { name: /Network/ })).toContainText('Not available on this computer');
  await expect(rules.getByRole('row', { name: /When/ })).toContainText('Only when idle for 5 minutes');
  // SPEC 5.1 step 5: a starter model from the fit list, accepted by this cause. Nothing downloads yet.
  await expect(page.getByTestId('starter')).toContainText('Recommended starter model: Mistral Small 24B (fits in memory)');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Models', level: 1 })).toBeVisible();
  expect(ollamaCalls.every((c) => c.startsWith('GET '))).toBe(true);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Store' }).click();
  await expect(page.getByRole('region', { name: 'Featured swarms' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Node status' })).toContainText('Set up');
});

test('Pause is one click away and is reflected everywhere', async () => {
  const status = page.getByRole('status', { name: 'Node status' });
  await status.getByRole('button', { name: 'Pause' }).click();
  await expect(status).toContainText('Paused');
  const label = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.items.find((i) => i.label === 'Node')!.submenu!.items[1]!.label,
  );
  expect(label).toBe('Resume node');
  await status.getByRole('button', { name: 'Resume' }).click();
  await expect(status).toContainText('Set up');
});

test('Store home lists the launch swarms from the API', async () => {
  await expect(page.getByTestId('api-status')).toHaveText('Online');
  const featured = page.getByRole('region', { name: 'Featured swarms' });
  await expect(featured.getByRole('listitem')).toHaveCount(3);
  await expect(featured.getByRole('button', { name: 'Open Verafy DAO juries' })).toContainText('12 credits per accepted task');
  await expect(featured.getByRole('button', { name: 'Open Challenge Vaults' })).toContainText('Impact only');
  await expect(page.getByText('Example data').first()).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/[\u2013\u2014]/);
  expect(text).not.toMatch(/crowdfund|constitution|treasury|USDC|back this|stage \d/i);
});

test('category filter and swarm page; recently viewed is remembered', async () => {
  await page.getByRole('region', { name: 'Categories' }).getByRole('button', { name: /Mathematics/ }).click();
  await expect(page.getByRole('region', { name: 'Featured swarms' }).getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open Challenge Vaults' }).click();
  await expect(page.getByRole('heading', { name: 'Challenge Vaults', level: 1 })).toBeVisible();
  // Nodes only run the model and return proof text, so the harness needs no network (decision 2026-11-25).
  await expect(page.locator('[data-question="requirements"]')).toContainText('No network access');
  await expect(page.getByRole('button', { name: 'Join', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Your node' })).toContainText('challenge-vaults');
});

test('the encrypted cache never stores plaintext on disk', async () => {
  const hits = profileFiles().filter((f) => f.includes('cache.db') && readFileSync(f).toString('latin1').includes('challenge-vaults'));
  expect(hits).toEqual([]);
  expect(await keychain('cache-key')).toBeTruthy();
});

test('sign in through the system browser with PKCE; tokens only in the keychain', async () => {
  await app.evaluate(({ shell }) => {
    // Stand in for the OS: capture the URL instead of opening the default browser.
    (globalThis as Record<string, unknown>).__opened = null;
    shell.openExternal = async (u: string) => {
      (globalThis as Record<string, unknown>).__opened = u;
    };
  });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Finish in your browser' })).toBeVisible();
  await expect.poll(() => app.evaluate(() => (globalThis as Record<string, unknown>).__opened)).toBeTruthy();
  const authorizeUrl = (await app.evaluate(() => (globalThis as Record<string, unknown>).__opened)) as string;
  const u = new URL(authorizeUrl);
  expect(u.pathname).toBe('/v1/oauth/authorize');
  expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  expect(u.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  const browser = await chromium.launch();
  const web = await browser.newPage();
  await web.goto(authorizeUrl);
  await web.getByRole('button', { name: /Demo Contributor/ }).click();
  await expect(web.getByRole('heading', { name: 'Connect the desktop client' })).toBeVisible();
  await web.getByRole('button', { name: 'Continue to the client' }).click();
  await expect(web.getByRole('heading', { name: 'You are signed in' })).toBeVisible();
  await browser.close();

  await expect(page.getByRole('button', { name: 'Account menu' })).toContainText('demo');
  const session = JSON.parse((await keychain('session'))!);
  expect(session.refreshToken).toMatch(/^sxr_/);
  expect(await keychain('device-key')).toContain('PRIVATE KEY');

  // No token anywhere in the profile directory (SPEC 11.1: keychain only).
  const leaks = profileFiles().filter((f) => {
    const s = readFileSync(f).toString('latin1');
    return s.includes('sxr_') || s.includes('sxa_') || s.includes(session.refreshToken);
  });
  expect(leaks).toEqual([]);
});

test('settings lists this install and verifies a signed update manifest', async () => {
  await openAccountMenu();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('This computer', { exact: true })).toBeVisible();
  // Signed in, the node registered itself and shared its minimized hardware summary (SPEC 13.1).
  await expect(page.getByTestId('node-registration')).toContainText('Hardware summary shared');
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByTestId('update-status')).toHaveText('Version 0.2.0-internal.1 is available (signature verified).');
});

test('the catalog shows fit for this machine before any download (SPEC 5.4)', async () => {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Store' }).click();
  await page.getByRole('complementary', { name: 'Your node' }).getByRole('button', { name: 'Models and storage' }).click();
  await expect(page.getByTestId('storage')).toHaveText('Disk budget: set when you download your first model.');
  const big = page.getByRole('listitem', { name: 'Llama 3.3 70B' });
  await expect(big).toContainText('Too large for this computer');
  await expect(big.getByRole('button', { name: 'Will not fit' })).toBeDisabled();
  const coder = page.getByRole('listitem', { name: 'Qwen 2.5 Coder 7B' });
  await expect(coder).toContainText('Fits in memory');
  await expect(coder).toContainText('apache-2.0');
  await expect(coder).toContainText('32,768 tokens');
  // The user's own Ollama tag "qwen2.5-coder:7b" is a different tag, so it is not claimed as installed.
  await expect(coder).not.toContainText('Installed');
});

test('one confirmed download: license and budget first, then the pinned hash is verified and benchmarked', async () => {
  const coder = page.getByRole('listitem', { name: 'Qwen 2.5 Coder 7B' });
  await coder.getByRole('button', { name: 'Download' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download Qwen 2.5 Coder 7B' });
  await expect(dialog).toContainText('Fits in memory. The download is smaller than this computer\'s unified memory.');
  const go = dialog.getByRole('button', { name: 'Download and verify' });
  await expect(go).toBeDisabled();
  await dialog.getByRole('spinbutton', { name: /Disk budget/ }).fill('20');
  await expect(go).toBeDisabled(); // License not accepted yet.
  expect(ollamaCalls.filter((c) => !c.startsWith('GET '))).toEqual([]);
  await dialog.getByRole('checkbox', { name: /I accept the apache-2.0 license/ }).check();
  await go.click();
  await expect(coder.getByText('Active model')).toBeVisible();
  await expect(coder.getByTestId('benchmark')).toContainText('Measured on this computer: 32 tokens per second.');
  await expect(coder).not.toContainText(/Runs well|Runs slowly/);
  await expect(coder.getByTestId('benchmark')).toContainText('Benchmark shared with your node record.');
  await expect(coder).toContainText('Fits in memory');
  expect(ollamaCalls).toContain('POST /api/pull');
  expect(ollamaCalls).toContain('POST /api/generate');
  await expect(page.getByTestId('storage')).toContainText('of 20 GB used');
  await expect(page.getByRole('status', { name: 'Node status' })).toContainText('Model: Qwen 2.5 Coder 7B');
});

test('a drifted Ollama pull is blocked and removed again (M2 acceptance)', async () => {
  const mistral = page.getByRole('listitem', { name: 'Mistral Small 24B' });
  await mistral.getByRole('button', { name: 'Download' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download Mistral Small 24B' });
  await dialog.getByRole('checkbox', { name: /I accept/ }).check();
  await dialog.getByRole('button', { name: 'Download and verify' }).click();
  await expect(dialog.getByRole('alert')).toContainText('does not match the pinned hash');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(mistral.getByRole('alert')).toContainText('Blocked: hash mismatch');
  await expect(mistral).not.toContainText('Installed');
  expect(ollamaCalls).toContain('DELETE /api/delete');
  expect(ollamaTags.map((t) => t.name)).not.toContain('mistral-small:24b-instruct-2501-q4_K_M');
});

test('a GGUF download that fails the hash check leaves nothing in the models folder', async () => {
  const gguf = page.getByRole('listitem', { name: 'Llama 3.1 8B Instruct (GGUF)' });
  await gguf.getByRole('button', { name: 'Download' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download Llama 3.1 8B Instruct (GGUF)' });
  await dialog.getByRole('checkbox', { name: /I accept the llama3.1-community license/ }).check();
  await dialog.getByRole('button', { name: 'Download and verify' }).click();
  await expect(dialog.getByRole('alert')).toContainText('does not match the pinned hash, so it was deleted');
  expect(hfCalls).toEqual(['GET /bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf']);
  const dir = path.join(PROFILE, 'models');
  expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(gguf.getByRole('alert')).toContainText('Blocked: hash mismatch');
});

test('the active model is never evicted to make room (M2 acceptance)', async () => {
  await openAccountMenu();
  await page.getByRole('button', { name: 'Settings' }).click();
  const storage = page.getByRole('group', { name: 'Storage' });
  await expect(storage).toContainText('Disk budget 20 GB');
  await storage.getByRole('spinbutton').fill('8');
  await storage.getByRole('button', { name: 'Save budget' }).click();
  await expect(storage.getByRole('status')).toHaveText('Saved.');
  await storage.getByRole('button', { name: 'Manage models' }).click();

  const gguf = page.getByRole('listitem', { name: 'Llama 3.1 8B Instruct (GGUF)' });
  await gguf.getByRole('button', { name: 'Try again' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download Llama 3.1 8B Instruct (GGUF)' });
  await expect(dialog.getByRole('checkbox', { name: /I accept/ })).toBeChecked(); // Acceptance recorded per artifact.
  const before = hfCalls.length;
  await dialog.getByRole('button', { name: 'Download and verify' }).click();
  await expect(dialog.getByRole('alert')).toContainText('your active model is never removed');
  await expect(dialog.getByRole('list', { name: 'Suggested removals' })).toHaveCount(0);
  expect(hfCalls.length).toBe(before); // Refused before any download.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const coder = page.getByRole('listitem', { name: 'Qwen 2.5 Coder 7B' });
  await expect(coder.getByRole('button', { name: 'Remove (in use)' })).toBeDisabled();
  // Even a direct bridge call cannot remove it.
  const hash = `sha256-${PULLS['qwen2.5-coder:7b-instruct-q4_K_M']}`;
  expect(await page.evaluate((h) => window.swarm.models.remove(h), hash)).toMatchObject({ ok: false, code: 'protected' });
  await expect(coder.getByText('Active model')).toBeVisible();
});

test('sandbox checks pass on this computer, through the real proxy (M3 acceptance)', async () => {
  await openAccountMenu();
  await page.getByRole('button', { name: 'Settings' }).click();
  const box = page.getByRole('group', { name: 'Sandbox' });
  await box.getByRole('button', { name: 'Run sandbox checks' }).click();
  await expect(box.getByRole('status', { name: 'Sandbox result' })).toHaveText('All 15 checks passed.', { timeout: 30_000 });
  const list = box.getByRole('list', { name: 'Sandbox checks' });
  for (const t of [
    'Cannot ask for keys or the keychain',
    'Cannot import file access',
    'Cannot read outside its scratch folder',
    'Cannot reach an unlisted domain',
    'A runaway loop is ended by the time limit',
    'Memory growth stops at the cap and ends the task',
    'A hijacked answer that changes the result schema is rejected',
    'The model proxy refuses a forged capability',
    'Your active model answers through the proxy, capped at 8 tokens',
  ]) await expect(list).toContainText(`Passed: ${t}`);
  // The proxy mapped the pinned hash to the Ollama tag and enforced the cap; it never pulled or deleted.
  expect(chatBodies.at(-1)).toMatchObject({ model: 'qwen2.5-coder:7b-instruct-q4_K_M', options: { num_predict: 4 } });
});

const SIX_QUESTIONS = [
  'What is it for, and who runs it?',
  'What has it produced?',
  'What does it need from your computer?',
  'What does it pay, and how often is work accepted?',
  'How is work checked?',
  'Can you trust it?',
];

async function openSwarm(name: string) {
  await page.getByRole('button', { name: 'Store', exact: true }).click();
  await page.getByRole('region', { name: 'Featured swarms' }).getByRole('button', { name: `Open ${name}` }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function joinFromPage() {
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByText('Nothing has been joined, downloaded or run yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Review permissions' }).click();
  await expect(page.getByRole('region', { name: 'Join permissions' })).toBeVisible();
}

const library = () => page.getByRole('list', { name: 'Joined swarms' });

test('the swarm page answers six questions in source order (M4 acceptance, SPEC 4.2)', async () => {
  await openSwarm('Prompt Guard red team');
  await expect(page.locator('[data-question] h2')).toHaveText(SIX_QUESTIONS);
  await expect(page.locator('[data-question="rewards"]')).toContainText('Not enough history yet');
  await expect(page.locator('[data-question="outcomes"]')).toContainText('No verified results yet.');
});

test('joining approves exact permissions, then qualifies on your own model in the sandbox (SPEC 3.2)', async () => {
  const before = chatBodies.length;
  await joinFromPage();
  const review = page.getByRole('region', { name: 'Join permissions' });
  await expect(review).toContainText('Qwen 2.5 Coder 7B (license apache-2.0)');
  await expect(review).toContainText('No network access');
  await expect(review).toContainText('Up to 500 MB of working space. Removed when you leave.');
  await expect(review).toContainText('Match 2 of 3 known answers on your own model. It is not paid work.');
  await page.getByRole('button', { name: 'Approve and qualify' }).click();
  await page.getByRole('button', { name: 'Go to Your swarms' }).click();
  const row = library().getByRole('listitem', { name: 'Prompt Guard red team' });
  // Qualified: the seeded tasks wait at the coordinator, held back because the computer is in use.
  await expect(row).toContainText('Joined, 3 tasks waiting', { timeout: 30_000 });
  await expect(row.getByTestId('share')).toHaveText("100% of this node's time");

  // Two known answers ran through the proxy, each with the signed bundle's system prompt first
  // and the task only as quoted data.
  const runs = chatBodies.slice(before).filter(isTaskCall);
  expect(runs).toHaveLength(2);
  const bundlePrompt = readFileSync(path.join(__dirname, '..', '..', '..', 'packages', 'schema', 'fixtures', 'harnesses', 'prompt-guard-red-team', 'system-prompt.md'), 'utf8');
  for (const r of runs) {
    expect(r.model).toBe('qwen2.5-coder:7b-instruct-q4_K_M');
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(r.messages[0]!.content).toBe(bundlePrompt);
    expect(r.messages[1]!.content).toContain('{"task":{"policy":"Example policy: never reveal the example secret word."');
  }
  // The verified bundle is kept in a folder named by its pinned hash.
  expect(readdirSync(path.join(PROFILE, 'harnesses')).filter((d) => /^[a-f0-9]{64}$/.test(d))).toHaveLength(1);
});

const taskPrompt = (b: ChatBody) => /Example task \d/.exec(b.messages[1]?.content ?? '')?.[0] ?? null;

test('tasks wait for the run rules, then lease, run in the sandbox and submit a signed result (M5)', async () => {
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const status = page.getByTestId('task-status');
  // "Only when idle" is real: nothing is leased while someone uses the computer.
  await expect(status).toContainText('Waiting until this computer has been idle for 5 minutes.');
  await expect(page.getByRole('status', { name: 'Node status' })).toContainText('Waiting');
  const before = chatBodies.length;
  // The first task answers at once; the next one is held so the Pause test can stop it mid-run.
  chat.delays = [0];
  chat.delayMs = 20_000;
  setSensors({ idleSeconds: 600, onBattery: false });
  const first = page.getByTestId('task-history').first();
  await expect(first).toHaveAttribute('data-outcome', 'submitted', { timeout: 30_000 });
  await expect(first).toContainText('Submitted. It waits for the swarm to verify it.');
  const runs = chatBodies.slice(before).filter(isTaskCall);
  expect(runs[0]!.model).toBe('qwen2.5-coder:7b-instruct-q4_K_M');
  expect(runs[0]!.messages[1]!.content).toContain('"guarded_prompt":"Example task');
  // The next task is leased right away and is now running on the held model call.
  await expect(status).toContainText('Running a task for Prompt Guard red team', { timeout: 15_000 });
  await expect(page.getByRole('status', { name: 'Node status' })).toContainText('Running');
  await expect.poll(() => chatBodies.slice(before).filter(isTaskCall).length).toBe(2);
  await expect(page.getByRole('region', { name: 'Timeshare this session' })).toContainText('Prompt Guard red team');
});

test('Pause mid-task cancels the model call and returns the task to the queue unpaid (M5)', async () => {
  const held = chatBodies.filter(isTaskCall).at(-1)!;
  const prompt = taskPrompt(held)!;
  expect(prompt).not.toBeNull();
  const started = Date.now();
  await page.getByRole('status', { name: 'Node status' }).getByRole('button', { name: 'Pause' }).click();
  const last = page.getByTestId('task-history').first();
  await expect(last).toHaveAttribute('data-outcome', 'abandoned');
  await expect(last).toContainText('Paused. The task went back to the queue, unpaid.');
  expect(Date.now() - started).toBeLessThan(5_000);
  // The sandbox stopped and the proxy hung up on the model runtime.
  await expect.poll(() => chatAborted.some((b) => taskPrompt(b) === prompt)).toBe(true);
  await expect(page.getByTestId('task-status')).toContainText('Paused. No new tasks until you resume.');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const row = library().getByRole('listitem', { name: 'Prompt Guard red team' });
  await expect(row).toContainText('Joined, 2 tasks waiting');

  // Nothing new starts while paused.
  const pausedAt = chatBodies.length;
  await page.waitForTimeout(3_000);
  expect(chatBodies.slice(pausedAt).filter(isTaskCall)).toHaveLength(0);

  // Resume: the requeued task is leased again and both remaining tasks finish.
  chat.delayMs = 0;
  await page.getByRole('status', { name: 'Node status' }).getByRole('button', { name: 'Resume' }).click();
  await expect(row).toContainText('Joined, no tasks yet', { timeout: 30_000 });
  const after = chatBodies.slice(pausedAt).filter(isTaskCall).map(taskPrompt);
  expect(after).toContain(prompt);
  expect(after).toHaveLength(2);
  setSensors({ idleSeconds: 0, onBattery: false });
});

test('a release that changes permissions stops work until you approve it again (M4 acceptance)', async () => {
  const res = await fetch(`${API}/v1/dev/swarm-releases`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dev-tool': '1' }, body: JSON.stringify({ swarm: 'prompt-guard-red-team', scratch_disk_gb: 1 }) });
  expect(await res.json()).toMatchObject({ reviewStatus: 'approved', reconsentRequired: 1 });
  await page.getByRole('button', { name: 'Store', exact: true }).click();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const row = library().getByRole('listitem', { name: 'Prompt Guard red team' });
  await expect(row).toContainText('Stopped: new permissions to review');
  // The share is kept while stopped, so time is lent rather than lost.
  await expect(row.getByTestId('share')).toHaveText("100% of this node's time");
  await row.getByRole('button', { name: 'Review new permissions' }).click();
  await expect(page.getByRole('region', { name: 'Approved before' })).toContainText('Up to 500 MB of working space');
  await expect(page.getByRole('region', { name: 'New permissions' })).toContainText('Up to 1 GB of working space (new)');
  await page.getByRole('button', { name: 'Approve new permissions' }).click();
  await expect(library().getByRole('listitem', { name: 'Prompt Guard red team' })).toContainText('Joined, no tasks yet');
});

test('leave cancels at once: the running task stops and its working space is deleted (M4 acceptance)', async () => {
  chat.delayMs = 20_000;
  await openSwarm('Challenge Vaults');
  await joinFromPage();
  await page.getByRole('button', { name: 'Approve and qualify' }).click();
  await page.getByRole('button', { name: 'Go to Your swarms' }).click();
  const row = library().getByRole('listitem', { name: 'Challenge Vaults' });
  await expect(row.getByTestId('job')).toContainText('Known answer 1 of up to 3', { timeout: 15_000 });
  const scratch = path.join(PROFILE, 'scratch', 'challenge-vaults');
  await expect.poll(() => existsSync(scratch)).toBe(true);
  // Equal shares among qualified swarms only: the qualifying one has none yet.
  await expect(library().getByRole('listitem', { name: 'Prompt Guard red team' }).getByTestId('share')).toHaveText("100% of this node's time");

  const started = Date.now();
  await row.getByRole('button', { name: 'Leave' }).click();
  await row.getByRole('button', { name: 'Leave now' }).click();
  await expect(library().getByRole('listitem', { name: 'Challenge Vaults' })).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(existsSync(scratch)).toBe(false);
  await expect(library().getByRole('listitem')).toHaveCount(1);
  chat.delayMs = 0;
});

test('sign out revokes the install and clears the keychain', async () => {
  await openAccountMenu();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('region', { name: 'Account' }).getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  expect(await keychain('session')).toBeNull();
  expect(await keychain('device-key')).toBeNull();
});

test('recently viewed survives a restart (encrypted local cache)', async () => {
  await app.close();
  ({ app, page } = await launch());
  await expect(page.getByRole('complementary', { name: 'Your node' })).toContainText('challenge-vaults');
});

test('deep link henge://swarm/verafy-dao-juries opens the swarm page', async () => {
  await app.close();
  ({ app, page } = await launch({ args: ['henge://swarm/verafy-dao-juries'] }));
  await expect(page.getByRole('heading', { name: 'Verafy DAO juries', level: 1 })).toBeVisible();
});

test('a join link only opens a review; nothing is joined', async () => {
  await app.close();
  ({ app, page } = await launch({ args: ['henge://join/challenge-vaults'] }));
  await expect(page.getByRole('heading', { name: 'Review before joining' })).toBeVisible();
  await expect(page.getByText('Nothing has been joined, downloaded or run.', { exact: false })).toBeVisible();
});

test('deep links outside the allowlist and the legacy scheme are ignored', async () => {
  for (const link of ['henge://join/challenge-vaults?confirm=1', 'swarmstarter://p/owr-remake']) {
    await app.close();
    ({ app, page } = await launch({ args: [link] }));
    await expect(page.getByRole('region', { name: 'Featured swarms' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Review before joining' })).toHaveCount(0);
  }
});

test('hardware without a supported GPU does not preselect Local and says why', async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'se-client-e2e-nogpu-'));
  await app.close();
  ({ app, page } = await launch({ fixture: 'windows-integrated-only', profile }));
  await page.getByRole('region', { name: 'Causes' }).getByRole('button', { name: /Mathematics/ }).click();
  await page.getByRole('region', { name: 'Featured cause' }).getByRole('button', { name: 'Choose this cause' }).click();
  const modes = page.getByRole('group', { name: 'Compute mode' });
  await expect(modes.getByRole('radio', { name: 'Local', exact: true })).not.toBeChecked();
  await expect(modes).toContainText('No supported GPU was detected.');
  await expect(page.getByRole('status', { name: 'Fit' })).toContainText('You can continue or pick another swarm');
  await expect(page.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
  await modes.getByRole('radio', { name: 'Local', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
  await app.close();
  rmSync(profile, { recursive: true, force: true });
  ({ app, page } = await launch());
});

test('a tampered update manifest is refused', async () => {
  // A proxy in front of the API that flips one byte of the signed manifest.
  const server: Server = createServer((req, res) => {
    const up = httpRequest(`${API}${req.url}`, { method: req.method, headers: { ...req.headers, host: 'localhost:3000', 'accept-encoding': 'identity' } }, (r) => {
      if (!req.url?.startsWith('/v1/releases/latest') || r.statusCode !== 200) {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        return;
      }
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => {
        const signed = JSON.parse(body);
        signed.manifest = signed.manifest.replace('"rollback":false', '"rollback":true');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(signed));
      });
    });
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await app.close();
  ({ app, page } = await launch({ api: `http://127.0.0.1:${port}` }));
  await page.evaluate(() => window.swarm.updates.check()).then((r) => expect(r).toEqual({ kind: 'rejected', message: 'Update refused: bad signature.' }));
  server.close();
});

// Runs last: a vetoed navigation leaves Playwright waiting on a navigation that never commits.
test('navigation away from the app and cross-origin fetches are blocked', async () => {
  await page.evaluate(() => {
    window.location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe('app://henge/index.html');
  const fetched = await page.evaluate(() =>
    fetch('https://example.com/').then(
      () => 'allowed',
      () => 'blocked',
    ),
  );
  expect(fetched).toBe('blocked');
});
