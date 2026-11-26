/**
 * Swarm manifest JSON Schemas (SPEC 6.4, 6.5), Draft 2020-12.
 *
 * `coreManifestSchema` is the SPEC 6.5 schema verbatim. It validates the shape of
 * Rex's source example (SPEC 6.3) and nothing more.
 *
 * `manifestV1Schema` is the production schema: every SPEC 6.4 field, unknown fields
 * rejected unless namespaced `x-`. Cross-field rules (economics, diversity,
 * healthcare data) are in invariants.ts, because the spec keeps them server side.
 */

export const CATEGORIES = ['governance', 'mathematics', 'security', 'science', 'healthcare', 'public_goods', 'gaming'] as const;
export const VERIFICATION_METHODS = ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review'] as const;
export const MODEL_POLICIES = ['any', 'class', 'diverse'] as const;

/** SPEC 6.5, verbatim. */
export const coreManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Henge core manifest',
  type: 'object',
  required: ['id', 'name', 'publisher', 'category', 'summary', 'harness', 'models', 'verification', 'permissions', 'credits', 'task', 'qualification', 'results_url'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    name: { type: 'string', minLength: 1 },
    publisher: { type: 'string', minLength: 1 },
    category: { enum: ['governance', 'mathematics', 'security', 'science', 'healthcare', 'public_goods', 'gaming'] },
    summary: { type: 'string', minLength: 1 },
    harness: {
      type: 'object',
      required: ['name', 'version', 'hash'],
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        hash: { type: 'string', pattern: '^sha256-[a-f0-9]{64}$' },
      },
      additionalProperties: false,
    },
    models: {
      type: 'object',
      required: ['policy', 'api_allowed'],
      properties: {
        policy: { enum: ['any', 'class', 'diverse'] },
        class: { type: 'string' },
        api_allowed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    verification: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: ['machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review'] },
    },
    permissions: {
      type: 'object',
      required: ['network', 'scratch_disk_gb'],
      properties: {
        network: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        scratch_disk_gb: { type: 'number', minimum: 0 },
      },
      additionalProperties: false,
    },
    credits: {
      type: 'object',
      required: ['funded'],
      properties: {
        funded: { type: 'boolean' },
        per_accepted_task: { type: ['integer', 'null'], minimum: 1 },
        pool_id: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
    task: {
      type: 'object',
      required: ['timeout_s', 'max_parallel_per_node'],
      properties: {
        timeout_s: { type: 'integer', minimum: 1 },
        max_parallel_per_node: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    qualification: {
      type: 'object',
      required: ['tasks', 'pass'],
      properties: {
        tasks: { type: 'integer', minimum: 1 },
        pass: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    results_url: { type: 'string', pattern: '^https://' },
  },
  patternProperties: { '^x-': {} },
  additionalProperties: false,
} as const;

const SEMVER = '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$';
/** Lowercase DNS name with an alphabetic TLD: no scheme, port, path, wildcard or IP literal (SPEC 6.4, 11.3). */
export const DOMAIN = '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$';
const HTTPS = '^https://[^\\s]+$';
const DIGEST = '^sha256-[a-f0-9]{64}$';
const xOnly = { patternProperties: { '^x-': {} }, additionalProperties: false } as const;
const nullable = (t: 'integer' | 'number' | 'string') => ({ type: [t, 'null'] });

/** Production `manifest_version: 1` schema (SPEC 6.4). */
export const manifestV1Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://henge.verafy.ai/schemas/manifest-v1.json',
  title: 'Henge manifest v1',
  type: 'object',
  required: [
    'manifest_version', 'id', 'name', 'publisher', 'category', 'summary', 'harness', 'models', 'verification',
    'verification_config', 'permissions', 'credits', 'impact', 'task', 'qualification', 'results_url', 'coordinator',
    'data_policy', 'min_client_version',
  ],
  properties: {
    manifest_version: { const: 1 },
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]*$', maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    publisher: { type: 'string', minLength: 1, maxLength: 253 },
    category: { enum: CATEGORIES },
    summary: { type: 'string', minLength: 1, maxLength: 280 },
    harness: {
      type: 'object',
      required: ['name', 'version', 'hash', 'runtime'],
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
        version: { type: 'string', pattern: SEMVER },
        hash: { type: 'string', pattern: DIGEST },
        runtime: { enum: ['wasm', 'container'] },
      },
      ...xOnly,
    },
    models: {
      type: 'object',
      required: ['policy', 'api_allowed'],
      properties: {
        policy: { enum: MODEL_POLICIES },
        class: { type: 'string', minLength: 1 },
        allowed_classes: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
        api_allowed: { type: 'boolean' },
        diversity: {
          type: 'object',
          required: ['min_families', 'min_accounts'],
          properties: { min_families: { type: 'integer', minimum: 2 }, min_accounts: { type: 'integer', minimum: 2 } },
          ...xOnly,
        },
      },
      ...xOnly,
    },
    verification: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: VERIFICATION_METHODS } },
    verification_config: {
      type: 'object',
      required: ['pending_window_s'],
      properties: {
        known_answer_rate: { type: ['number', 'null'], exclusiveMinimum: 0, maximum: 1 },
        redundancy_count: { type: ['integer', 'null'], minimum: 2 },
        jury_panel_size: { type: ['integer', 'null'], minimum: 2 },
        pending_window_s: { type: 'integer', minimum: 0 },
      },
      ...xOnly,
    },
    permissions: {
      type: 'object',
      required: ['network', 'scratch_disk_gb', 'gpu_compute', 'api_spend_daily_usd'],
      properties: {
        network: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: DOMAIN } },
        scratch_disk_gb: { type: 'number', minimum: 0 },
        gpu_compute: { type: 'boolean' },
        api_spend_daily_usd: { type: ['number', 'null'], minimum: 0 },
      },
      ...xOnly,
    },
    credits: {
      type: 'object',
      required: ['funded', 'per_accepted_task', 'pool_id'],
      properties: {
        funded: { type: 'boolean' },
        per_accepted_task: { type: ['integer', 'null'], minimum: 1 },
        pool_id: { type: ['string', 'null'], minLength: 1 },
      },
      ...xOnly,
    },
    impact: {
      type: 'object',
      required: ['category_weight'],
      properties: { category_weight: { type: 'integer', minimum: 0 } },
      ...xOnly,
    },
    task: {
      type: 'object',
      required: ['timeout_s', 'max_parallel_per_node', 'urgent_allowed', 'input_schema', 'output_schema'],
      properties: {
        timeout_s: { type: 'integer', minimum: 1 },
        max_parallel_per_node: { type: 'integer', minimum: 1 },
        urgent_allowed: { type: 'boolean' },
        input_schema: { type: 'string', pattern: HTTPS },
        output_schema: { type: 'string', pattern: HTTPS },
      },
      ...xOnly,
    },
    qualification: {
      type: 'object',
      required: ['tasks', 'pass'],
      properties: { tasks: { type: 'integer', minimum: 1 }, pass: { type: 'integer', minimum: 1 } },
      ...xOnly,
    },
    results_url: { type: 'string', pattern: HTTPS },
    coordinator: {
      type: 'object',
      required: ['mode', 'url', 'public_key'],
      properties: {
        mode: { enum: ['hosted', 'self_hosted'] },
        url: { type: ['string', 'null'], pattern: HTTPS },
        public_key: nullable('string'),
      },
      ...xOnly,
    },
    data_policy: {
      type: 'object',
      required: ['public_inputs', 'retention_days', 'sensitive_data_prohibited'],
      properties: {
        public_inputs: { type: 'boolean' },
        retention_days: { type: 'integer', minimum: 0 },
        sensitive_data_prohibited: { type: 'boolean' },
      },
      ...xOnly,
    },
    min_client_version: { type: 'string', pattern: SEMVER },
    signatures: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key_id', 'algorithm', 'signature'],
        properties: {
          key_id: { type: 'string', minLength: 1 },
          algorithm: { const: 'ed25519' },
          signature: { type: 'string', pattern: '^[A-Za-z0-9+/]+={0,2}$' },
        },
        additionalProperties: false,
      },
    },
  },
  ...xOnly,
} as const;

/**
 * `harness.json` at the root of a harness bundle (SPEC 6.1). Every path is relative to
 * the bundle root. Capabilities are host-mediated: a harness asks for `model.complete`
 * through the proxy and never receives a credential, runtime admin endpoint or socket.
 */
export const HARNESS_CAPABILITIES = ['model.complete', 'scratch.read', 'scratch.write', 'network.fetch', 'checker.run'] as const;

const RELPATH = '^(?!/)(?!.*(^|/)\\.\\.(/|$))[A-Za-z0-9._/-]+$';

export const harnessBundleSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://henge.verafy.ai/schemas/harness-v1.json',
  title: 'Henge harness bundle v1',
  type: 'object',
  required: ['harness_version', 'name', 'version', 'runtime', 'entry', 'system_prompt', 'tools', 'loop', 'output_schema', 'min_model_class', 'capabilities', 'limits', 'fixtures', 'licenses', 'sbom'],
  properties: {
    harness_version: { const: 1 },
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    version: { type: 'string', pattern: SEMVER },
    runtime: { enum: ['wasm', 'container'] },
    /** wasm module path, or an OCI image digest for containers. */
    entry: { type: 'string', minLength: 1 },
    system_prompt: { type: 'string', pattern: RELPATH },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'description', 'input_schema'],
        properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' }, description: { type: 'string' }, input_schema: { type: 'string', pattern: RELPATH } },
        additionalProperties: false,
      },
    },
    loop: {
      type: 'object',
      required: ['max_steps', 'retries', 'step_timeout_s', 'total_timeout_s'],
      properties: {
        max_steps: { type: 'integer', minimum: 1 },
        retries: { type: 'integer', minimum: 0 },
        step_timeout_s: { type: 'integer', minimum: 1 },
        total_timeout_s: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    output_schema: { type: 'string', pattern: RELPATH },
    min_model_class: { type: 'string', minLength: 1 },
    capabilities: { type: 'array', uniqueItems: true, items: { enum: HARNESS_CAPABILITIES } },
    limits: {
      type: 'object',
      required: ['memory_mb', 'cpu_ms', 'wall_s', 'scratch_mb', 'processes'],
      properties: {
        memory_mb: { type: 'integer', minimum: 1 },
        cpu_ms: { type: 'integer', minimum: 1 },
        wall_s: { type: 'integer', minimum: 1 },
        scratch_mb: { type: 'integer', minimum: 0 },
        processes: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    fixtures: { type: 'array', minItems: 1, items: { type: 'string', pattern: RELPATH } },
    licenses: { type: 'array', minItems: 1, items: { type: 'string', pattern: RELPATH } },
    sbom: { type: 'string', pattern: RELPATH },
  },
  patternProperties: { '^x-': {} },
  additionalProperties: false,
} as const;
