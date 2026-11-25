/**
 * Static checks on a harness module before anything runs (SPEC 11.3): the module may import only
 * the host functions its granted capabilities link, plus the host-provided memory. It may not
 * define its own memory (so the host's size cap is the only memory), import tables or globals, or
 * carry a start function (nothing runs before the broker's limits are armed).
 */

/** Host functions and the capability each belongs to. Nothing else is ever linked. */
export const HOST_FUNCTIONS = {
  model_complete: 'model.complete',
  net_fetch: 'network.fetch',
  scratch_read: 'scratch.read',
  scratch_write: 'scratch.write',
  log: 'log',
} as const;
export type HostFunction = keyof typeof HOST_FUNCTIONS;
export type Capability = (typeof HOST_FUNCTIONS)[HostFunction];

export type WasmCheck = { ok: true; imports: HostFunction[] } | { ok: false; reason: string };

function readU32(bytes: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    if (pos >= bytes.length || shift > 28) throw new Error('bad leb128');
    const b = bytes[pos++]!;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
}

/** Section ids present in the module, with the declared count for counted sections. */
function sections(bytes: Uint8Array): Map<number, number> {
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (bytes.length < 8 || magic.some((b, i) => bytes[i] !== b)) throw new Error('not a wasm module');
  const out = new Map<number, number>();
  let pos = 8;
  while (pos < bytes.length) {
    const id = bytes[pos++]!;
    const [size, body] = readU32(bytes, pos);
    if (body + size > bytes.length) throw new Error('truncated section');
    // Custom sections (0) carry no code; counted sections start with a vector length.
    if (id !== 0 && id !== 8) out.set(id, (out.get(id) ?? 0) + (size ? readU32(bytes, body)[0] : 0));
    if (id === 8) out.set(8, 1);
    pos = body + size;
  }
  return out;
}

export function checkHarnessModule(bytes: Uint8Array, granted: ReadonlySet<Capability>): WasmCheck {
  let mod: WebAssembly.Module;
  let secs: Map<number, number>;
  try {
    secs = sections(bytes);
    mod = new WebAssembly.Module(bytes as BufferSource);
  } catch (e) {
    return { ok: false, reason: `invalid module: ${e instanceof Error ? e.message : 'unknown'}` };
  }
  if ((secs.get(5) ?? 0) > 0) return { ok: false, reason: 'module defines its own memory; it must import swarm.memory' };
  if (secs.has(8)) return { ok: false, reason: 'module has a start function' };

  const linked: HostFunction[] = [];
  let memory = false;
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.module !== 'swarm') return { ok: false, reason: `imports from "${imp.module}", which is not provided` };
    if (imp.kind === 'memory' && imp.name === 'memory') {
      memory = true;
      continue;
    }
    if (imp.kind !== 'function' || !(imp.name in HOST_FUNCTIONS)) return { ok: false, reason: `imports swarm.${imp.name} (${imp.kind}), which is not a host capability` };
    const cap = HOST_FUNCTIONS[imp.name as HostFunction];
    if (cap !== 'log' && !granted.has(cap)) return { ok: false, reason: `imports swarm.${imp.name} but the "${cap}" permission was not granted` };
    linked.push(imp.name as HostFunction);
  }
  if (!memory) return { ok: false, reason: 'module must import swarm.memory' };
  const exports = new Map(WebAssembly.Module.exports(mod).map((e) => [e.name, e.kind]));
  if (exports.get('run') !== 'function' || exports.get('alloc') !== 'function') return { ok: false, reason: 'module must export run and alloc functions' };
  return { ok: true, imports: linked };
}
