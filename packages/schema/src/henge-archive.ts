/**
 * In-memory extraction of `.henge.zip` and `.henge.tar.gz` bundles (spin-out spec v2, 6.5 step 3).
 * Web platform only (DecompressionStream), so no new dependency. Symlinks, hard links, devices,
 * encrypted entries and ZIP64 are refused; output is capped while it inflates, so a small
 * archive cannot expand past the bundle cap.
 */

export class HengeArchiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ExtractedArchive {
  files: Map<string, Uint8Array>;
  /** Paths whose mode carries an executable bit. */
  executableBits: Set<string>;
}

/** Inflate a gzip or raw deflate stream, refusing output larger than `maxBytes`. */
export async function inflate(data: Uint8Array, format: 'gzip' | 'deflate-raw', maxBytes: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream(format));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch (err) {
      throw new HengeArchiveError('archive_corrupt', `Could not decompress the archive: ${String(err)}`);
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HengeArchiveError('bundle_too_large', `The bundle expands past ${maxBytes} bytes.`);
    }
    chunks.push(r.value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

const dec = new TextDecoder();
const cstr = (b: Uint8Array, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return dec.decode(end === -1 ? s : s.subarray(0, end));
};
const octal = (b: Uint8Array, start: number, len: number) => {
  const s = cstr(b, start, len).trim();
  return s ? parseInt(s, 8) : 0;
};

function addFile(out: ExtractedArchive, path: string, data: Uint8Array, mode: number, state: { total: number }, maxBytes: number) {
  state.total += data.byteLength;
  if (state.total > maxBytes) throw new HengeArchiveError('bundle_too_large', `The bundle is larger than ${maxBytes} bytes.`);
  if (out.files.has(path)) throw new HengeArchiveError('archive_duplicate_path', `${path} appears twice in the archive.`);
  out.files.set(path, data);
  if (mode & 0o111) out.executableBits.add(path);
}

/** Parse a ustar/pax/GNU tar stream already gunzipped. */
export function extractTar(tar: Uint8Array, maxBytes: number): ExtractedArchive {
  const out: ExtractedArchive = { files: new Map(), executableBits: new Set() };
  const state = { total: 0 };
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] ?? 0);
    const mode = octal(h, 100, 8);
    const prefix = cstr(h, 257, 6).startsWith('ustar') ? cstr(h, 345, 155) : '';
    const baseName = cstr(h, 0, 100);
    const dataStart = off + 512;
    if (dataStart + size > tar.length) throw new HengeArchiveError('archive_corrupt', 'The tar archive is truncated.');
    const body = tar.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = cstr(body, 0, body.length);
      continue;
    }
    if (type === 'x') {
      const text = dec.decode(body);
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text);
      if (m) paxPath = m[1]!;
      continue;
    }
    if (type === 'g') continue;
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    paxPath = null;
    longName = null;
    if (type === '2' || type === '1') throw new HengeArchiveError('archive_symlink', `${name} is a link. Bundles may not contain symlinks or hard links.`);
    if (type === '5') continue;
    if (type !== '0' && type !== '\0' && type !== '7') throw new HengeArchiveError('archive_special_file', `${name} is not a regular file.`);
    addFile(out, name.replace(/^\.\//, ''), body.slice(), mode, state, maxBytes);
  }
  return out;
}

const u16 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8)) >>> 0;
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Parse a ZIP archive from its central directory. Stored and deflated entries only. */
export async function extractZip(zip: Uint8Array, maxBytes: number): Promise<ExtractedArchive> {
  const out: ExtractedArchive = { files: new Map(), executableBits: new Set() };
  const state = { total: 0 };
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--)
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new HengeArchiveError('archive_corrupt', 'Not a ZIP archive.');
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  // Refuse anything that declares more than the cap before inflating a byte.
  let declared = 0;
  const entries: { name: string; method: number; csize: number; usize: number; local: number; mode: number; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(zip, p) !== 0x02014b50) throw new HengeArchiveError('archive_corrupt', 'Bad ZIP central directory.');
    const madeBy = u16(zip, p + 4) >> 8;
    const flags = u16(zip, p + 8);
    const method = u16(zip, p + 10);
    const csize = u32(zip, p + 20);
    const usize = u32(zip, p + 24);
    const nlen = u16(zip, p + 28);
    const elen = u16(zip, p + 30);
    const clen = u16(zip, p + 32);
    const ext = u32(zip, p + 38);
    const local = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new HengeArchiveError('archive_unsupported', 'ZIP64 archives are not supported.');
    const mode = madeBy === 3 ? ext >>> 16 : 0;
    if ((mode & 0o170000) === 0o120000) throw new HengeArchiveError('archive_symlink', `${name} is a symlink. Bundles may not contain symlinks.`);
    if (name.endsWith('/')) continue;
    if (mode && (mode & 0o170000) !== 0o100000) throw new HengeArchiveError('archive_special_file', `${name} is not a regular file.`);
    if (flags & 1) throw new HengeArchiveError('archive_unsupported', `${name} is encrypted.`);
    if (method !== 0 && method !== 8) throw new HengeArchiveError('archive_unsupported', `${name} uses an unsupported compression method.`);
    declared += usize;
    if (declared > maxBytes) throw new HengeArchiveError('bundle_too_large', `The bundle is larger than ${maxBytes} bytes.`);
    entries.push({ name, method, csize, usize, local, mode, flags });
  }
  for (const e of entries) {
    if (u32(zip, e.local) !== 0x04034b50) throw new HengeArchiveError('archive_corrupt', `Bad local header for ${e.name}.`);
    const start = e.local + 30 + u16(zip, e.local + 26) + u16(zip, e.local + 28);
    const raw = zip.subarray(start, start + e.csize);
    const data = e.method === 0 ? raw.slice() : await inflate(raw, 'deflate-raw', e.usize);
    if (data.byteLength !== e.usize) throw new HengeArchiveError('archive_corrupt', `${e.name} does not match its declared size.`);
    addFile(out, e.name, data, e.mode, state, maxBytes);
  }
  return out;
}

/**
 * Put `henge.yaml` at the root: accept it at the archive root, or inside one top-level folder
 * (for example `resolved-forecasts.henge/henge.yaml`), which is then stripped.
 */
export function rootArchive(a: ExtractedArchive): ExtractedArchive {
  if (a.files.has('henge.yaml')) return a;
  const tops = new Set([...a.files.keys()].map((p) => p.split('/')[0]));
  const [top] = [...tops];
  if (tops.size !== 1 || !top || !a.files.has(`${top}/henge.yaml`)) throw new HengeArchiveError('bundle_missing_manifest', 'The archive has no henge.yaml at its root or in a single top folder.');
  const strip = (p: string) => p.slice(top.length + 1);
  return {
    files: new Map([...a.files].map(([p, d]) => [strip(p), d])),
    executableBits: new Set([...a.executableBits].map(strip)),
  };
}
