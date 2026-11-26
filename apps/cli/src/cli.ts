import { readFile } from 'node:fs/promises';
import { ApiError, categorySchema, createApiClient, type ApiClient } from '@swarm-explorer/api-client';
import { categoryLabel, formatCredits } from '@swarm-explorer/core';
import { parseManifest } from '@swarm-explorer/schema';
import { verifyReceipt, type PlatformPublicKey } from '@swarm-explorer/schema/node';

export const VERSION = '0.1.0';

const HELP = `swarm ${VERSION} (Henge CLI)

Usage:
  swarm swarms [--category <key>]   List listed swarms
  swarm show <id>                   Show one swarm
  swarm validate <manifest.yaml>    Check a swarm manifest against schema v1 and its invariants

  swarm receipt verify <receipt.json> [--keys <keys.json> | --fetch-keys]
                                    Verify a contribution receipt offline. --keys takes the
                                    platform's receipt keys (GET /v1/receipts/keys) saved to a file;
                                    --fetch-keys reads them from the API instead
  swarm init | dev | verify | package | publish
                                    Developer platform (arrives in M11)
  swarm node start                  Headless node (arrives with the node milestones)
  swarm --version | --help

Environment:
  SWARM_EXPLORER_API_URL   API base URL (default http://localhost:3000)`;

/** SPEC 16.4 milestones for commands that are reserved but not built. */
const PLANNED: Record<string, string> = { init: 'M11', dev: 'M11', verify: 'M11', package: 'M11', publish: 'M11', login: 'M5', node: 'M5' };

export type Io = { out: (s: string) => void; err: (s: string) => void };
export type Deps = { api: ApiClient; readFile: (p: string) => Promise<string> };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const defaultDeps = (): Deps => ({
  api: createApiClient({ baseUrl: process.env['SWARM_EXPLORER_API_URL'] ?? 'http://localhost:3000' }),
  readFile: (p) => readFile(p, 'utf8'),
});

/** Returns the process exit code: 0 ok, 1 API or validation failure, 2 usage, 3 not built yet. */
export async function run(argv: string[], io: Io, deps: Deps = defaultDeps()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case undefined:
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;
      case '--version':
      case '-v':
        io.out(VERSION);
        return 0;
      case 'swarms': {
        const rawCategory = flag(rest, 'category');
        const category = categorySchema.optional().safeParse(rawCategory);
        if (!category.success) {
          io.err(`Unknown category "${rawCategory}". Use one of: ${categorySchema.options.join(', ')}`);
          return 2;
        }
        const list = await deps.api.listSwarms({ category: category.data });
        for (const s of list.items) {
          const reward = s.funding.mode === 'funded' ? `${formatCredits(s.funding.creditsPerAcceptedTask)} per accepted task` : 'impact only';
          io.out(`${s.slug.padEnd(24)} ${categoryLabel(s.category).padEnd(22)} ${reward}`);
        }
        io.out(`${list.items.length} swarms (example data)`);
        return 0;
      }
      case 'show': {
        const slug = rest[0];
        if (!slug) {
          io.err('Usage: swarm show <id>');
          return 2;
        }
        const s = await deps.api.getSwarm(slug);
        io.out(`${s.name}\n${s.summary}\nby ${s.publisher.name}`);
        io.out(`  harness  ${s.harness.name} ${s.harness.version} (${s.harness.runtime})`);
        io.out(`  reward   ${s.funding.mode === 'funded' ? `${formatCredits(s.funding.creditsPerAcceptedTask)} per accepted task, pool ${s.funding.poolStatus}` : 'impact only'}`);
        io.out(`  network  ${s.permissions.network.length ? s.permissions.network.join(', ') : 'none'}`);
        io.out(`  manifest ${s.release.manifestHash}`);
        return 0;
      }
      case 'validate': {
        const file = rest[0];
        if (!file) {
          io.err('Usage: swarm validate <manifest.yaml>');
          return 2;
        }
        const result = parseManifest(await deps.readFile(file));
        if (result.ok) {
          io.out(`${file}: valid manifest v1 for "${result.manifest.id}"`);
          return 0;
        }
        for (const i of result.issues) io.err(`${file}: ${i.path || '/'} ${i.code}: ${i.message}`);
        return 1;
      }
      case 'receipt':
        return await receiptCommand(rest, io, deps);
      default:
        if (cmd in PLANNED) {
          io.err(`"${cmd}" is not available yet; it arrives in milestone ${PLANNED[cmd]}. See swarm --help.`);
          return 3;
        }
        io.err(`Unknown command "${cmd}". See swarm --help.`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      io.err(`API error (${e.code}): ${e.message}`);
      return 1;
    }
    io.err(`Could not reach the API. Is the website running? (${(e as Error).message})`);
    return 1;
  }
}

/**
 * `swarm receipt verify`: checks a receipt offline (M7). The signature is checked against the key the
 * receipt names; with --keys or --fetch-keys that key must also be one of the platform's receipt keys.
 * Exit 0 valid, 1 invalid, 2 usage.
 */
async function receiptCommand(args: string[], io: Io, deps: Deps): Promise<number> {
  const [sub, file] = args;
  if (sub !== 'verify' || !file) {
    io.err('Usage: swarm receipt verify <receipt.json> [--keys <keys.json> | --fetch-keys]');
    return 2;
  }
  let value: unknown;
  try {
    value = JSON.parse(await deps.readFile(file));
  } catch {
    io.err(`${file}: not a JSON file.`);
    return 1;
  }
  // The API's envelope ({ receipt }) and a bare receipt are both accepted.
  if (value && typeof value === 'object' && 'receipt' in value) value = (value as { receipt: unknown }).receipt;
  let keys: PlatformPublicKey[] | undefined;
  const keysFile = flag(args, 'keys');
  if (keysFile) {
    try {
      const k = JSON.parse(await deps.readFile(keysFile)) as { keys?: PlatformPublicKey[] } | PlatformPublicKey[];
      keys = Array.isArray(k) ? k : (k.keys ?? []);
    } catch {
      io.err(`${keysFile}: not a JSON keys file.`);
      return 1;
    }
  } else if (args.includes('--fetch-keys')) {
    keys = (await deps.api.receiptKeys()).keys;
  }
  const r = verifyReceipt(value, keys);
  if (!r.ok) {
    io.err(`${file}: not valid (${r.reason}): ${r.detail}`);
    return 1;
  }
  const earned = r.receipt.earned.credits === null ? `${r.receipt.earned.impact_units} impact` : `${r.receipt.earned.impact_units} impact and ${r.receipt.earned.credits} credits`;
  io.out(`${file}: valid receipt ${r.receipt.receipt_id} for result ${r.receipt.result.id} in ${r.receipt.swarm.slug}.`);
  io.out(`  settled  ${r.receipt.timeline.settled_at}`);
  io.out(`  checked  ${r.receipt.verification.map((v) => v.method).join(', ')}`);
  io.out(`  earned   ${earned}`);
  io.out(
    r.keyTrusted
      ? `  signer   ${r.keyId}, one of the platform's receipt keys`
      : `  signer   ${r.keyId}. The signature matches, but this key was not checked against the platform's receipt keys; pass --keys or --fetch-keys.`,
  );
  return 0;
}
