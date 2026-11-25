/** Test and build helper: compiles the check WAT sources with wabt. Never loaded at runtime. */
import { CHECK_WAT } from './check-wat';

export async function compileChecks(): Promise<Record<string, string>> {
  const wabt = await (await import('wabt')).default();
  const out: Record<string, string> = {};
  for (const [name, src] of Object.entries(CHECK_WAT)) {
    const m = wabt.parseWat(`${name}.wat`, src);
    m.resolveNames();
    m.validate();
    out[name] = Buffer.from(m.toBinary({}).buffer).toString('base64');
    m.destroy();
  }
  return out;
}
