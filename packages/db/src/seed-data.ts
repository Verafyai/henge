/**
 * Example seed data for local development and tests. Every account, model, size and
 * price here is example data. Swarm manifests come from packages/schema/fixtures.
 */

export const seedAccounts = [
  { handle: 'demo', displayName: 'Demo Contributor', platformRole: 'none' },
  { handle: 'verafy-team', displayName: 'Verafy Team (example)', platformRole: 'none' },
  { handle: 'reviewer', displayName: 'Example Reviewer', platformRole: 'reviewer' },
] as const;

export const seedOauthClients = [
  {
    id: 'swarm-explorer-desktop',
    name: 'Swarm Explorer desktop',
    kind: 'desktop' as const,
    redirectUris: ['http://127.0.0.1/callback', 'swarmexplorer://auth/callback'],
  },
];

export const seedPublisher = {
  slug: 'verafy.ai',
  name: 'Verafy',
  owner: 'verafy-team',
  // Domain control has not been proven in this environment, so no Verified badge (SPEC 11.6).
  badgeStatus: 'pending' as const,
};

/** Launch swarms (SPEC 16.1) by fixture file. All three are listed and featured locally. */
export const seedSwarmFiles = ['verafy-dao-juries.yaml', 'challenge-vaults.yaml', 'prompt-guard-red-team.yaml'] as const;

/**
 * Example model catalog. Names follow the spec's examples (SPEC 2.1) and are not
 * recommendations. Sizes and context lengths are approximate illustrations. The content
 * hashes are fixture digests, not the real artifacts, so a node's hash check refuses them. Source
 * references point at the public names a real catalog would pin.
 */
export const seedModels = [
  { slug: 'llama3.3-70b', source: 'ollama', family: 'llama', displayName: 'Llama 3.3 70B', modelClass: 'jury-panel-member', licenseId: 'llama3.3-community', artifact: { versionLabel: '70b-instruct-q4_K_M', sourceRef: 'llama3.3:70b-instruct-q4_K_M', sizeBytes: 42_500_000_000, contextLength: 131_072, quantization: 'Q4_K_M' } },
  { slug: 'qwen2.5-72b', source: 'ollama', family: 'qwen', displayName: 'Qwen 2.5 72B', modelClass: 'jury-panel-member', licenseId: 'qwen', artifact: { versionLabel: '72b-instruct-q4_K_M', sourceRef: 'qwen2.5:72b-instruct-q4_K_M', sizeBytes: 47_400_000_000, contextLength: 32_768, quantization: 'Q4_K_M' } },
  { slug: 'mistral-small-24b', source: 'ollama', family: 'mistral', displayName: 'Mistral Small 24B', modelClass: 'jury-panel-member', licenseId: 'apache-2.0', artifact: { versionLabel: '24b-instruct-q4_K_M', sourceRef: 'mistral-small:24b-instruct-2501-q4_K_M', sizeBytes: 14_300_000_000, contextLength: 32_768, quantization: 'Q4_K_M' } },
  { slug: 'qwen2.5-coder-7b', source: 'ollama', family: 'qwen', displayName: 'Qwen 2.5 Coder 7B', modelClass: 'code-7b-plus', licenseId: 'apache-2.0', artifact: { versionLabel: '7b-instruct-q4_K_M', sourceRef: 'qwen2.5-coder:7b-instruct-q4_K_M', sizeBytes: 4_700_000_000, contextLength: 32_768, quantization: 'Q4_K_M' } },
  { slug: 'llama3.1-8b-gguf', source: 'huggingface', family: 'llama', displayName: 'Llama 3.1 8B Instruct (GGUF)', modelClass: 'instruct-7b-plus', licenseId: 'llama3.1-community', artifact: { versionLabel: 'Q4_K_M.gguf', sourceRef: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF@main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', sizeBytes: 4_900_000_000, contextLength: 131_072, quantization: 'Q4_K_M' } },
] as const;

/**
 * Pricing proposal from the SPEC 9.6 examples (1 credit for $0.01, 20 percent take rate).
 * Stored as a proposal; nothing may use it until Rex approves a config (SPEC 9.6A).
 */
export const seedEconomicProposal = {
  creditPriceMinor: 1,
  currency: 'USD',
  takeRateBp: 2_000,
  hostedFreeTaskVolume: null,
  privateSeatPriceMinor: null,
  notes: 'SPEC 9.6 examples. Proposal only, not approved. How the take rate applies is undecided (SPEC 9.6A).',
};
