/**
 * TEST ONLY. Two stand-in catalog entries that the desktop e2e needs and the approved catalog does not
 * have: a Hugging Face GGUF file (the hash-mismatch download path) and a model too large for the test
 * machine (the "will not fit" state). They are seeded only when `seed({ testModels: true })` runs on the
 * embedded test database (`SEED_TEST_MODELS=1` with PGlite), never in the production seed. Their
 * hashes are fixture digests of a label, not real artifacts, so a real node's hash check refuses them.
 */
export const testOnlyModels = [
  {
    slug: 'test-only-gguf',
    source: 'huggingface',
    family: 'test',
    displayName: 'Test only: GGUF stand-in',
    modelClass: 'test-only',
    licenseId: 'test-only-license',
    artifact: { versionLabel: 'Q4_K_M.gguf', sourceRef: 'example/test-only-GGUF@main/test-only-Q4_K_M.gguf', sizeBytes: 4_000_000_000, contextLength: null, quantization: 'Q4_K_M' },
  },
  {
    slug: 'test-only-too-large',
    source: 'ollama',
    family: 'test',
    displayName: 'Test only: too large',
    modelClass: 'test-only',
    licenseId: 'test-only-license',
    artifact: { versionLabel: 'huge-q4_K_M', sourceRef: 'test-only-too-large:huge-q4_K_M', sizeBytes: 90_000_000_000, contextLength: null, quantization: 'Q4_K_M' },
  },
] as const;

export const testOnlyDigest = (slug: string, versionLabel: string) => `fixture-artifact:test-only:${slug}:${versionLabel}`;
