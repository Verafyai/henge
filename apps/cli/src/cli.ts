import { readFile } from 'node:fs/promises';
import { ApiError, categorySchema, createApiClient, type ApiClient } from '@swarm-explorer/api-client';
import { categoryLabel, formatCredits } from '@swarm-explorer/core';
import { parseManifest } from '@swarm-explorer/schema';

export const VERSION = '0.1.0';

const HELP = `swarm ${VERSION} (Henge CLI)

Usage:
  swarm swarms [--category <key>]   List listed swarms
  swarm show <id>                   Show one swarm
  swarm validate <manifest.yaml>    Check a swarm manifest against schema v1 and its invariants
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
