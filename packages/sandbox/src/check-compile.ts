/** Test and build helper: compiles the check WAT sources with wabt. Never loaded at runtime. */
import { CHECK_WAT, TASK_HARNESS_WAT } from './check-wat';

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

/** Compiles the fixture task harness to a binary module. */
export async function compileTaskHarness(): Promise<Uint8Array> {
  const wabt = await (await import('wabt')).default();
  const m = wabt.parseWat('task-harness.wat', TASK_HARNESS_WAT);
  m.resolveNames();
  m.validate();
  const bin = new Uint8Array(m.toBinary({}).buffer);
  m.destroy();
  return bin;
}
