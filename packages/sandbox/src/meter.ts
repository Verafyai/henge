/**
 * Deterministic instruction metering for harness WebAssembly (`meter/1`).
 *
 * Node's built-in WebAssembly has no fuel, so the broker rewrites each module at load time. The
 * pass adds one mutable i64 global (the fuel counter, exported under `FUEL_EXPORT` so only the host
 * can read and set it) and inserts a charge at the start of every metered region:
 *
 *   global.get $fuel; i64.const <cost>; i64.sub; global.set $fuel;
 *   global.get $fuel; i64.const 0; i64.lt_s; if; unreachable; end
 *
 * A region starts at function entry and right after every `block`, `loop`, `if`, `else` and inner
 * `end`. It runs up to and including the next of those instructions, and its cost is the number of
 * original instructions in it. Every region holds at least one instruction, so every loop back edge
 * and every call charges at least 1: a harness cannot spin or recurse without spending fuel.
 *
 * The count depends only on the module bytes and the path the code takes, never on the machine,
 * the engine's tiering or the clock, so the same harness, input and host replies use the same fuel
 * everywhere. Host functions count as one instruction; their own work is bounded by the other
 * limits (wall time, model calls, reply caps).
 *
 * The pass understands the WebAssembly 1.0 instruction set plus sign extension, saturating
 * truncation, multi-value block types, reference types and bulk memory. Any other opcode (SIMD,
 * threads, exceptions, tail calls, GC) is refused, so nothing runs unmetered.
 */

/** Names the instrumentation in run records. Change it whenever the cost rules change. */
export const METER_VERSION = 'meter/1';

/** Export name of the injected fuel counter. A module that already exports it is refused. */
export const FUEL_EXPORT = '__swarm_meter_fuel';

/**
 * Fuel budget per run when the harness and manifest name none. Neither SPEC 6.1 nor 6.4 defines a
 * fuel field, and no number is approved, so this is null (Needs Rex): fuel is counted and recorded,
 * and no fuel limit stops a run. The wall-time, memory and model-call limits still apply.
 */
export const APPROVED_FUEL_BUDGET: number | null = null;

/** Counter start for a run with no fuel limit: the largest i64, which no run can spend. */
export const UNLIMITED_FUEL = (1n << 63n) - 1n;

export type MeteredModule = { ok: true; bytes: Uint8Array; meter: typeof METER_VERSION } | { ok: false; reason: string };

class Unmeterable extends Error {}

function u32(b: Uint8Array, at: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    if (pos >= b.length || shift > 28) throw new Unmeterable('bad leb128');
    const x = b[pos++]!;
    result |= (x & 0x7f) << shift;
    if ((x & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
  }
}

/** Skips one LEB128 value of up to 64 bits (signed or unsigned). */
function skipLeb(b: Uint8Array, at: number): number {
  let pos = at;
  for (let i = 0; i < 10; i++) {
    if (pos >= b.length) throw new Unmeterable('truncated leb128');
    if ((b[pos++]! & 0x80) === 0) return pos;
  }
  throw new Unmeterable('leb128 too long');
}

function encU32(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

function encS64(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    const done = (v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

const VALTYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x70, 0x6f]);
const REFTYPES = new Set([0x70, 0x6f]);

function blockType(b: Uint8Array, at: number): number {
  const x = b[at];
  if (x === undefined) throw new Unmeterable('truncated block type');
  if (x === 0x40 || VALTYPES.has(x)) return at + 1;
  if (x & 0x40) throw new Unmeterable(`unsupported block type 0x${x.toString(16)}`);
  return skipLeb(b, at); // a type index
}

function memarg(b: Uint8Array, at: number): number {
  const [align, p] = u32(b, at);
  if (align & 0x40) throw new Unmeterable('multiple memories are not supported');
  return skipLeb(b, p);
}

function zeroIndex(b: Uint8Array, at: number): number {
  const [idx, p] = u32(b, at);
  if (idx !== 0) throw new Unmeterable('multiple memories are not supported');
  return p;
}

type Kind = 'open' | 'else' | 'end' | 'other';

/** Decodes one instruction at `at`; returns its end and its control kind. */
function instruction(b: Uint8Array, at: number): [number, Kind] {
  const op = b[at];
  if (op === undefined) throw new Unmeterable('truncated code');
  const p = at + 1;
  if (op === 0x02 || op === 0x03 || op === 0x04) return [blockType(b, p), 'open'];
  if (op === 0x05) return [p, 'else'];
  if (op === 0x0b) return [p, 'end'];
  if (op === 0x00 || op === 0x01 || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1) return [p, 'other'];
  if (op === 0x0c || op === 0x0d || op === 0x10 || op === 0xd2 || op === 0x25 || op === 0x26) return [skipLeb(b, p), 'other'];
  if (op >= 0x20 && op <= 0x24) return [skipLeb(b, p), 'other'];
  if (op === 0x0e) {
    const [n, q] = u32(b, p);
    let r = q;
    for (let i = 0; i <= n; i++) r = skipLeb(b, r);
    return [r, 'other'];
  }
  if (op === 0x11) return [skipLeb(b, skipLeb(b, p)), 'other'];
  if (op === 0x1c) {
    const [n, q] = u32(b, p);
    for (let i = 0; i < n; i++) if (!VALTYPES.has(b[q + i]!)) throw new Unmeterable('unsupported select type');
    return [q + n, 'other'];
  }
  if (op >= 0x28 && op <= 0x3e) return [memarg(b, p), 'other'];
  if (op === 0x3f || op === 0x40) return [zeroIndex(b, p), 'other'];
  if (op === 0x41 || op === 0x42) return [skipLeb(b, p), 'other'];
  if (op === 0x43) return [p + 4, 'other'];
  if (op === 0x44) return [p + 8, 'other'];
  if (op >= 0x45 && op <= 0xc4) return [p, 'other'];
  if (op === 0xd0) {
    if (!REFTYPES.has(b[p]!)) throw new Unmeterable('unsupported ref.null type');
    return [p + 1, 'other'];
  }
  if (op === 0xfc) {
    const [sub, q] = u32(b, p);
    if (sub <= 7) return [q, 'other']; // saturating truncation
    if (sub === 8) return [zeroIndex(b, skipLeb(b, q)), 'other']; // memory.init data 0
    if (sub === 9 || sub === 13 || sub === 15 || sub === 16 || sub === 17) return [skipLeb(b, q), 'other'];
    if (sub === 10) return [zeroIndex(b, zeroIndex(b, q)), 'other']; // memory.copy 0 0
    if (sub === 11) return [zeroIndex(b, q), 'other']; // memory.fill 0
    if (sub === 12 || sub === 14) return [skipLeb(b, skipLeb(b, q)), 'other'];
    throw new Unmeterable(`unsupported instruction 0xfc ${sub}`);
  }
  throw new Unmeterable(`unsupported instruction 0x${op.toString(16)}`);
}

function charge(global: number, cost: number): number[] {
  const g = encU32(global);
  return [0x23, ...g, 0x42, ...encS64(BigInt(cost)), 0x7d, 0x24, ...g, 0x23, ...g, 0x42, 0x00, 0x53, 0x04, 0x40, 0x00, 0x0b];
}

/** Instruments one function body (locals plus code). */
function meterBody(b: Uint8Array, global: number): Uint8Array {
  const [groups, first] = u32(b, 0);
  let pos = first;
  for (let i = 0; i < groups; i++) {
    pos = u32(b, pos)[1];
    if (!VALTYPES.has(b[pos]!)) throw new Unmeterable('unsupported local type');
    pos += 1;
  }
  const locals = b.subarray(0, pos);
  const spans: Array<[number, number, Kind]> = [];
  let depth = 0;
  while (pos < b.length) {
    const [end, kind] = instruction(b, pos);
    if (end > b.length) throw new Unmeterable('truncated code');
    spans.push([pos, end, kind]);
    pos = end;
    if (kind === 'open') depth++;
    else if (kind === 'end' && depth-- === 0) break;
  }
  if (depth !== -1 || pos !== b.length) throw new Unmeterable('function body does not end cleanly');

  // Region starts: entry, and after every block, loop, if, else and inner end.
  const starts: number[] = [0];
  for (let i = 0; i < spans.length - 1; i++) if (spans[i]![2] !== 'other') starts.push(i + 1);
  const out: number[] = [...locals];
  for (let r = 0; r < starts.length; r++) {
    const from = starts[r]!;
    const to = r + 1 < starts.length ? starts[r + 1]! : spans.length;
    out.push(...charge(global, to - from));
    out.push(...b.subarray(spans[from]![0], spans[to - 1]![1]));
  }
  return new Uint8Array(out);
}

function section(id: number, body: number[] | Uint8Array): number[] {
  return [id, ...encU32(body.length), ...body];
}

/**
 * Rewrites a harness module for `meter/1`. Only the code, global and export sections change;
 * function, global and memory indices of the original module are untouched. Run the static
 * checks (`checkHarnessModule`) on the original bytes first.
 */
export function meterModule(bytes: Uint8Array): MeteredModule {
  try {
    if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Unmeterable('not a wasm module');
    const secs: Array<{ id: number; body: Uint8Array }> = [];
    let pos = 8;
    while (pos < bytes.length) {
      const id = bytes[pos++]!;
      const [size, start] = u32(bytes, pos);
      if (start + size > bytes.length) throw new Unmeterable('truncated section');
      secs.push({ id, body: bytes.subarray(start, start + size) });
      pos = start + size;
    }
    // Imported globals come first in the global index space.
    let importedGlobals = 0;
    const imp = secs.find((s) => s.id === 2)?.body;
    if (imp) {
      const [n, at] = u32(imp, 0);
      let p = at;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 2; k++) {
          const [len, q] = u32(imp, p);
          p = q + len;
        }
        const kind = imp[p++];
        if (kind === 0x00) p = skipLeb(imp, p);
        else if (kind === 0x01 || kind === 0x02) {
          if (kind === 0x01) p++;
          const flags = imp[p++]!;
          p = skipLeb(imp, p);
          if (flags & 1) p = skipLeb(imp, p);
        } else if (kind === 0x03) {
          importedGlobals++;
          p += 2;
        } else throw new Unmeterable('unsupported import kind');
      }
    }
    const globalSec = secs.find((s) => s.id === 6);
    const definedGlobals = globalSec ? u32(globalSec.body, 0)[0] : 0;
    const fuel = importedGlobals + definedGlobals;
    const fuelGlobal = [0x7e, 0x01, 0x42, 0x00, 0x0b]; // (mut i64) (i64.const 0); the host sets the budget

    const exp = secs.find((s) => s.id === 7);
    if (!exp) throw new Unmeterable('module has no exports');
    const [nExp, exportsAt] = u32(exp.body, 0);
    let ep = exportsAt;
    const dec = new TextDecoder();
    for (let i = 0; i < nExp; i++) {
      const [len, q] = u32(exp.body, ep);
      if (dec.decode(exp.body.subarray(q, q + len)) === FUEL_EXPORT) throw new Unmeterable(`module already exports ${FUEL_EXPORT}`);
      ep = skipLeb(exp.body, q + len + 1);
    }
    const name = [...new TextEncoder().encode(FUEL_EXPORT)];
    const newExports = [...encU32(nExp + 1), ...exp.body.subarray(exportsAt), ...encU32(name.length), ...name, 0x03, ...encU32(fuel)];

    const out: number[] = [...bytes.subarray(0, 8)];
    // The global section sits after type, import, function, table, memory and tag sections.
    const before = new Set([1, 2, 3, 4, 5, 13]);
    let globalWritten = false;
    const writeGlobal = (existing?: Uint8Array) => {
      const body = existing ? [...encU32(definedGlobals + 1), ...existing.subarray(u32(existing, 0)[1]), ...fuelGlobal] : [1, ...fuelGlobal];
      out.push(...section(6, body));
      globalWritten = true;
    };
    for (const s of secs) {
      if (!globalWritten && s.id !== 0 && s.id !== 6 && !before.has(s.id)) writeGlobal();
      if (s.id === 6) writeGlobal(s.body);
      else if (s.id === 7) out.push(...section(7, newExports));
      else if (s.id === 10) {
        const [n, at] = u32(s.body, 0);
        let p = at;
        const bodies: number[] = [...encU32(n)];
        for (let i = 0; i < n; i++) {
          const [size, q] = u32(s.body, p);
          if (q + size > s.body.length) throw new Unmeterable('truncated function body');
          const metered = meterBody(s.body.subarray(q, q + size), fuel);
          bodies.push(...encU32(metered.length), ...metered);
          p = q + size;
        }
        out.push(...section(10, bodies));
      } else out.push(...section(s.id, s.body));
    }
    if (!globalWritten) writeGlobal();
    const result = new Uint8Array(out);
    if (!WebAssembly.validate(result as BufferSource)) throw new Unmeterable('metered module does not validate');
    return { ok: true, bytes: result, meter: METER_VERSION };
  } catch (e) {
    if (e instanceof Unmeterable) return { ok: false, reason: `module cannot be metered: ${e.message}` };
    throw e;
  }
}
