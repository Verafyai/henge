import { parseDocument } from 'yaml';
import type { ManifestIssue } from './types';

/**
 * Manifests may be written in YAML (SPEC 6.4); the canonical signed object is JSON.
 * Parsing is strict: YAML 1.2 core schema only (no custom tags, no `<<` merges),
 * duplicate keys are errors, and aliases are refused so a manifest cannot expand
 * into a huge document.
 */
export function parseManifestSource(source: string): { ok: true; value: unknown } | { ok: false; issues: ManifestIssue[] } {
  if (source.length > 256 * 1024) return { ok: false, issues: [{ code: 'too_large', path: '', message: 'Manifest source is larger than 256 KB.' }] };
  const doc = parseDocument(source, { schema: 'core', merge: false, uniqueKeys: true, prettyErrors: false, strict: true });
  // Warnings (unknown tags, for example) are refused too: a manifest must mean exactly what it says.
  const issues: ManifestIssue[] = [...doc.errors, ...doc.warnings].map((e) => ({ code: 'yaml_syntax', path: '', message: e.message }));
  if (issues.length) return { ok: false, issues };
  try {
    // maxAliasCount 0 makes any alias throw during conversion.
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    return { ok: true, value };
  } catch (err) {
    const hasAlias = /alias/i.test(String(err));
    return { ok: false, issues: [{ code: hasAlias ? 'yaml_alias' : 'yaml_value', path: '', message: hasAlias ? 'YAML aliases are not allowed in manifests.' : String(err) }] };
  }
}
