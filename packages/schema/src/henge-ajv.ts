import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import glyphSchema from './glyph-v1.schema.json';
import hengeSchema from './henge-v1.schema.json';
import type { ManifestIssue } from './types';

/** The published JSON Schemas, as plain objects. */
export const hengeV1Schema = hengeSchema as Record<string, unknown>;
export const glyphV1Schema = glyphSchema as Record<string, unknown>;

let compiled: { henge: ValidateFunction; glyph: ValidateFunction } | null = null;

/** Ajv compiles with `new Function`: servers, the CLI and the client main process only, never a renderer. */
export function hengeValidators() {
  if (!compiled) {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      allowUnionTypes: true,
      // glyph-v1.schema.json uses format "uri"; a value must at least parse as an absolute URL.
      formats: { uri: { type: 'string', validate: (s: string) => URL.canParse(s) } },
    });
    compiled = { henge: ajv.compile(hengeV1Schema), glyph: ajv.compile(glyphV1Schema) };
  }
  return compiled;
}

export function schemaIssues(errors: ErrorObject[] | null | undefined): ManifestIssue[] {
  return (errors ?? []).map((e) => {
    const extra = e.keyword === 'additionalProperties' ? ` (${String((e.params as { additionalProperty: string }).additionalProperty)})` : '';
    const missing = e.keyword === 'required' ? `${e.instancePath}/${String((e.params as { missingProperty: string }).missingProperty)}` : e.instancePath;
    return { code: `schema_${e.keyword}`, path: missing, message: `${e.message ?? 'is invalid'}${extra}` };
  });
}
