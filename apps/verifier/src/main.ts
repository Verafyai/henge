/**
 * Runs the verifier worker until stopped. Configuration comes from the environment:
 *   VERIFIER_API_URL       the platform origin, for example http://localhost:3000
 *   VERIFIER_KEY_ID        the registered worker key id (the platform lists it in VERIFIER_WORKER_KEYS)
 *   VERIFIER_PRIVATE_KEY   the worker's Ed25519 private key, PKCS#8 DER in base64url. Never logged.
 *   LEAN_COMMAND           `lean` or `lake` (then LEAN_ARGS defaults to `env lean`); unset disables Lean
 *   LEAN_CWD               optional Lean project folder for `lake env lean`
 *   LEAN_TIMEOUT_MS        wall-clock limit per check; engineering default 60000
 *   VERIFIER_POLL_MS       delay between polls; engineering default 2000
 *   VERIFIER_HEALTH_PORT   optional: answers GET /health on 127.0.0.1 with the last poll time
 * Where this worker is hosted is not decided (DECISIONS.md, M6 Needs Rex).
 */
import { createServer } from 'node:http';
import { signingKeyFromPkcs8 } from '@swarm-explorer/verify';
import { detectIsolation, leanVerifier, promptGuardVerifier } from '@swarm-explorer/verify/worker';
import { createWorker } from './worker';

const env = process.env;
const need = (k: string) => {
  const v = env[k];
  if (!v) {
    console.error(`${k} is required.`);
    process.exit(2);
  }
  return v;
};

const key = signingKeyFromPkcs8(need('VERIFIER_KEY_ID'), need('VERIFIER_PRIVATE_KEY'));
const leanCmd = env['LEAN_COMMAND'];
const isolation = detectIsolation();
const worker = createWorker({
  apiUrl: need('VERIFIER_API_URL'),
  key,
  checkers: {
    lean: leanCmd
      ? leanVerifier({ command: leanCmd, args: env['LEAN_ARGS'] ? env['LEAN_ARGS'].split(' ') : leanCmd.endsWith('lake') ? ['env', 'lean'] : [], cwd: env['LEAN_CWD'], timeoutMs: Number(env['LEAN_TIMEOUT_MS'] ?? 60_000), isolation })
      : null,
    'prompt-guard-reproduction': promptGuardVerifier(),
  },
  log: (line) => console.log(`[verifier] ${line}`),
});

const pollMs = Number(env['VERIFIER_POLL_MS'] ?? 2_000);
console.log(`[verifier] key ${key.keyId}, Lean ${leanCmd ? `on (${isolation} isolation)` : 'off'}, polling every ${pollMs} ms`);
let lastPoll: string | null = null;
const healthPort = env['VERIFIER_HEALTH_PORT'];
const health = healthPort
  ? createServer((req, res) => {
      res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: req.url === '/health', last_poll: lastPoll }));
    }).listen(Number(healthPort), '127.0.0.1')
  : null;
let stop = false;
process.on('SIGTERM', () => (stop = true));
process.on('SIGINT', () => (stop = true));
while (!stop) {
  try {
    await worker.runOnce();
    lastPoll = new Date().toISOString();
  } catch (e) {
    console.log(`[verifier] poll failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
health?.close();
