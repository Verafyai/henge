import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { manifestInvariants } from './invariants';
import { coreManifestSchema, harnessBundleSchema, manifestV1Schema } from './json-schema';
import type { ManifestIssue, ManifestResult, ManifestV1 } from './types';
import { parseManifestSource } from './yaml';

let compiled: { core: ValidateFunction; v1: ValidateFunction; harness: ValidateFunction } | null = null;

/** Ajv compiles validators with `new Function`, so this runs on servers, the CLI and the client main process, never a renderer. */
function validators() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    compiled = { core: ajv.compile(coreManifestSchema), v1: ajv.compile(manifestV1Schema), harness: ajv.compile(harnessBundleSchema) };
  }
  return compiled;
}

function toIssues(errors: ErrorObject[] | null | undefined): ManifestIssue[] {
  return (errors ?? []).map((e) => {
    const extra = e.keyword === 'additionalProperties' ? ` (${String((e.params as { additionalProperty: string }).additionalProperty)})` : '';
    const missing = e.keyword === 'required' ? `${e.instancePath}/${String((e.params as { missingProperty: string }).missingProperty)}` : e.instancePath;
    return { code: `schema_${e.keyword}`, path: missing, message: `${e.message ?? 'is invalid'}${extra}` };
  });
}

/** SPEC 6.5 core schema only: the shape check for Rex's source example format. */
export function validateCoreManifest(value: unknown): ManifestIssue[] {
  const v = validators().core;
  return v(value) ? [] : toIssues(v.errors);
}

/** Full production check: v1 schema, then every SPEC 6.4 invariant. */
export function validateManifest(value: unknown): ManifestResult {
  const v = validators().v1;
  if (!v(value)) return { ok: false, issues: toIssues(v.errors) };
  const manifest = value as ManifestV1;
  const issues = manifestInvariants(manifest);
  return issues.length ? { ok: false, issues } : { ok: true, manifest };
}

/** YAML or JSON text in, validated manifest out. */
export function parseManifest(source: string): ManifestResult {
  const parsed = parseManifestSource(source);
  return parsed.ok ? validateManifest(parsed.value) : parsed;
}

/** Validate a bundle's `harness.json` (SPEC 6.1). */
export function validateHarnessBundle(value: unknown): ManifestIssue[] {
  const v = validators().harness;
  return v(value) ? [] : toIssues(v.errors);
}
