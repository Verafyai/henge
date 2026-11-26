/**
 * Local model proxy process (SPEC 11.1, 11.2): its own Electron utility process. It listens on a
 * private Unix socket or named pipe and answers only capability-scoped completions. The session
 * capability key arrives by message from main, never through the environment or disk. Provider
 * keys (API mode) stay off until the provider terms review (SPEC 5.5), so this process does not
 * touch the keychain yet. Local sources: Ollama, and llama.cpp's llama-server (an absolute path
 * resolved by main, since this process runs with an empty PATH).
 */
import { ModelProxy, type ProxyModel } from '@swarm-explorer/sandbox';
import { z } from 'zod';

type ParentPort = { on(ev: 'message', cb: (e: { data: unknown }) => void): void; postMessage(m: unknown): void };
const port = (process as unknown as { parentPort: ParentPort }).parentPort;

const configure = z.object({ type: z.literal('configure'), key: z.string().regex(/^[A-Za-z0-9_-]{43}$/), socketPath: z.string().min(1).max(200), ollamaBase: z.string().url().nullable(), llamaServer: z.string().max(1024).refine((v) => v.startsWith('/') || /^[A-Za-z]:\\/.test(v)).nullable().optional() });
const models = z.object({
  type: z.literal('models'),
  list: z.array(z.object({ contentHash: z.string().regex(/^sha256-[a-f0-9]{64}$/), runtime: z.enum(['ollama', 'llama_cpp']), ref: z.string().max(300), path: z.string().max(1024).optional() })).max(200),
});

let proxy: ModelProxy | null = null;
let pending: ProxyModel[] | null = null;

port.on('message', (e) => {
  const c = configure.safeParse(e.data);
  if (c.success && !proxy) {
    proxy = new ModelProxy({ key: Buffer.from(c.data.key, 'base64url'), socketPath: c.data.socketPath, ollamaBase: c.data.ollamaBase, llamaServer: c.data.llamaServer ?? null });
    void proxy.start().then(
      async () => {
        if (pending) await proxy!.setModels(pending);
        port.postMessage({ type: 'ready' });
      },
      () => port.postMessage({ type: 'failed' }),
    );
    return;
  }
  const m = models.safeParse(e.data);
  if (m.success) {
    if (!proxy) pending = m.data.list;
    else void proxy.setModels(m.data.list).then((r) => port.postMessage({ type: 'models', refused: r.refused }));
  }
});
