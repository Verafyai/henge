/**
 * Runtime discovery (SPEC 5.1 step 2): read-only. We look for an existing Ollama or llama.cpp and
 * list what is already there. Nothing is installed, started, pulled or changed here; managing a
 * runtime needs the user's permission and arrives with the local source adapters (M2).
 */
import { z } from 'zod';

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

export const runtimeSchema = z.object({
  kind: z.enum(['ollama', 'llama_cpp']),
  status: z.enum(['found', 'not_found', 'error']),
  version: z.string().max(60).nullable(),
  /** Where it was found: a loopback URL for Ollama, a binary name for llama.cpp. */
  location: z.string().max(300).nullable(),
  models: z.array(z.object({ name: z.string().max(200), digest: z.string().max(100).nullable(), sizeBytes: z.number().int().nonnegative().nullable() })).max(500),
  detail: z.string().max(300).nullable(),
});
export type RuntimeInfo = z.infer<typeof runtimeSchema>;

const tagsSchema = z.object({
  models: z
    .array(z.object({ name: z.string(), digest: z.string().optional(), size: z.number().optional() }).loose())
    .default([]),
});

/**
 * Ollama only listens on loopback by default. We refuse any configured host that is not loopback,
 * so discovery never sends a request off this machine.
 */
export function ollamaBaseUrl(env: Record<string, string | undefined>): string | null {
  const raw = env['OLLAMA_HOST'];
  if (!raw) return OLLAMA_DEFAULT_URL;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(host)) return null;
  // 0.0.0.0 means "listen everywhere"; we still connect over loopback.
  return `http://${host === '0.0.0.0' || host === 'localhost' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host}:${u.port || '11434'}`;
}

export async function discoverOllama(baseUrl: string | null, fetchFn: typeof fetch, timeoutMs = 2_000): Promise<RuntimeInfo> {
  const none = (status: RuntimeInfo['status'], detail: string | null): RuntimeInfo => ({ kind: 'ollama', status, version: null, location: baseUrl, models: [], detail });
  if (!baseUrl) return none('error', 'OLLAMA_HOST points off this computer, so it was not checked.');
  const get = async (path: string) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(new URL(path, baseUrl), { method: 'GET', signal: ctl.signal, headers: { accept: 'application/json' } });
      return res.ok ? ((await res.json()) as unknown) : null;
    } finally {
      clearTimeout(t);
    }
  };
  let version: unknown;
  try {
    version = await get('/api/version');
  } catch {
    return none('not_found', 'Ollama is not running on this computer.');
  }
  if (!version) return none('not_found', 'Ollama is not running on this computer.');
  const v = z.object({ version: z.string().max(60) }).safeParse(version);
  let tags: unknown = null;
  try {
    tags = await get('/api/tags');
  } catch {
    // Version answered but tags did not: report Ollama with no models listed.
  }
  const parsed = tagsSchema.safeParse(tags ?? {});
  return {
    kind: 'ollama',
    status: 'found',
    version: v.success ? v.data.version : null,
    location: baseUrl,
    models: parsed.success
      ? parsed.data.models.slice(0, 500).map((m) => ({ name: m.name.slice(0, 200), digest: m.digest ? `sha256-${m.digest.replace(/^sha256[:-]/, '')}`.slice(0, 100) : null, sizeBytes: typeof m.size === 'number' && m.size >= 0 ? Math.round(m.size) : null }))
      : [],
    detail: parsed.success ? null : 'Ollama answered, but its model list was not readable.',
  };
}

/** llama.cpp binaries we recognize, newest names first. */
export const LLAMA_CPP_BINARIES = ['llama-server', 'llama-cli', 'llama-server.exe', 'llama-cli.exe'];

/**
 * `which` resolves a binary name on PATH, or null. llama.cpp has no model registry, so we cannot
 * list models without the user pointing at a folder (M2).
 */
export async function discoverLlamaCpp(which: (bin: string) => Promise<string | null>): Promise<RuntimeInfo> {
  for (const bin of LLAMA_CPP_BINARIES) {
    const path = await which(bin);
    if (path) return { kind: 'llama_cpp', status: 'found', version: null, location: bin, models: [], detail: 'Models for llama.cpp are added from a folder you choose.' };
  }
  return { kind: 'llama_cpp', status: 'not_found', version: null, location: null, models: [], detail: null };
}
