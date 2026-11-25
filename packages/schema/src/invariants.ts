import type { ManifestIssue, ManifestV1 } from './types';

/**
 * Domains of model providers. Harnesses never reach these directly: model calls go
 * through the local proxy (SPEC 6.4, 11.2), so a manifest listing one is refused.
 */
export const MODEL_PROVIDER_DOMAINS = ['openrouter.ai', 'anthropic.com', 'openai.com', 'x.ai', 'claude.ai', 'chatgpt.com'] as const;

const underDomain = (host: string, d: string) => host === d || host.endsWith(`.${d}`);

/** Cross-field rules from SPEC 6.4 that JSON Schema cannot express. Returns every issue, not just the first. */
export function manifestInvariants(m: ManifestV1): ManifestIssue[] {
  const out: ManifestIssue[] = [];
  const add = (code: string, path: string, message: string) => out.push({ code, path, message });

  // Economics: funded needs a pool and a positive reward; volunteer swarms pay impact only (SPEC 6.4, 9.1).
  if (m.credits.funded) {
    if (!m.credits.pool_id) add('funded_requires_pool', '/credits/pool_id', 'A funded swarm must name its prepaid pool.');
    if (!m.credits.per_accepted_task || m.credits.per_accepted_task < 1)
      add('funded_requires_reward', '/credits/per_accepted_task', 'A funded swarm must pay a positive whole number of credits per accepted task.');
  } else {
    if (m.credits.per_accepted_task !== null) add('volunteer_reward_must_be_null', '/credits/per_accepted_task', 'Volunteer swarms award impact only; the credit reward must be null.');
    if (m.credits.pool_id !== null) add('volunteer_pool_must_be_null', '/credits/pool_id', 'Volunteer swarms have no credit pool until one is funded.');
  }

  // Model policy (SPEC 6.2).
  if (m.models.policy === 'class' && !m.models.class) add('class_policy_requires_class', '/models/class', 'The class policy needs a model class.');
  if (m.models.policy === 'diverse') {
    if (!m.models.diversity) add('diverse_requires_panel_rules', '/models/diversity', 'The diverse policy needs min_families and min_accounts.');
    if (!m.verification.includes('jury') && !m.verification.includes('redundancy'))
      add('diverse_requires_panel_verifier', '/verification', 'The diverse policy needs a panel verifier: jury or redundancy.');
  } else if (m.models.diversity) {
    add('diversity_without_diverse_policy', '/models/diversity', 'Panel rules apply only to the diverse policy.');
  }

  // Verifier configuration must exist for each method that needs it (SPEC 8.1: values are per swarm, no defaults).
  const vc = m.verification_config;
  if (m.verification.includes('known-answers') && (vc.known_answer_rate ?? null) === null)
    add('known_answers_requires_rate', '/verification_config/known_answer_rate', 'Known answers need the publisher-set known answer rate.');
  if (m.verification.includes('redundancy') && (vc.redundancy_count ?? null) === null)
    add('redundancy_requires_count', '/verification_config/redundancy_count', 'Redundancy needs the number of independent nodes.');
  if (m.verification.includes('jury') && (vc.jury_panel_size ?? null) === null)
    add('jury_requires_panel_size', '/verification_config/jury_panel_size', 'Jury verification needs a panel size.');
  if (m.models.diversity && vc.jury_panel_size && m.models.diversity.min_families > vc.jury_panel_size)
    add('panel_smaller_than_families', '/models/diversity/min_families', 'A panel cannot span more model families than it has jurors.');

  // Qualification (SPEC 6.4).
  if (m.qualification.pass > m.qualification.tasks) add('qualification_pass_exceeds_tasks', '/qualification/pass', 'The pass count cannot exceed the number of qualification tasks.');

  // Network: only harness domains; model providers go through the proxy (SPEC 6.4, 11.2).
  m.permissions.network.forEach((host, i) => {
    if (MODEL_PROVIDER_DOMAINS.some((d) => underDomain(host, d)))
      add('network_lists_model_provider', `/permissions/network/${i}`, `${host} is a model provider; model calls go through the local proxy, not the harness network.`);
  });

  // API spend only exists when API sources are allowed.
  if (!m.models.api_allowed && m.permissions.api_spend_daily_usd !== null)
    add('api_spend_without_api', '/permissions/api_spend_daily_usd', 'This swarm does not allow API sources, so it cannot request an API spend permission.');

  // Healthcare is public literature only (SPEC 6.4).
  if (m.category === 'healthcare') {
    if (!m.data_policy.sensitive_data_prohibited)
      add('healthcare_requires_sensitive_prohibited', '/data_policy/sensitive_data_prohibited', 'Healthcare swarms must prohibit sensitive data; patient data is out of scope.');
    if (!m.data_policy.public_inputs) add('healthcare_requires_public_inputs', '/data_policy/public_inputs', 'Healthcare swarms may use public literature only.');
  }

  // Coordinator (SPEC 10.1): self-hosted needs a reviewed URL and a published signing key.
  if (m.coordinator.mode === 'self_hosted') {
    if (!m.coordinator.url) add('self_hosted_requires_url', '/coordinator/url', 'A self-hosted coordinator needs its https URL.');
    if (!m.coordinator.public_key) add('self_hosted_requires_key', '/coordinator/public_key', 'A self-hosted coordinator must publish its signing key.');
  } else if (m.coordinator.url !== null || m.coordinator.public_key !== null) {
    add('hosted_coordinator_fields', '/coordinator', 'The hosted coordinator is run by the platform; url and public_key must be null.');
  }

  return out;
}

/** What changed between two releases of the same swarm, by the categories SPEC 6.4 names. */
export type ReleaseChange = 'permissions' | 'harness' | 'coordinator' | 'data_policy' | 'network' | 'economics' | 'models' | 'verification' | 'other';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function releaseChanges(prev: ManifestV1, next: ManifestV1): ReleaseChange[] {
  const c = new Set<ReleaseChange>();
  if (!same([...prev.permissions.network].sort(), [...next.permissions.network].sort())) c.add('network');
  const { network: _pn, ...pp } = prev.permissions;
  const { network: _nn, ...np } = next.permissions;
  if (!same(pp, np)) c.add('permissions');
  if (!same(prev.harness, next.harness)) c.add('harness');
  if (!same(prev.coordinator, next.coordinator)) c.add('coordinator');
  if (!same(prev.data_policy, next.data_policy)) c.add('data_policy');
  if (!same(prev.credits, next.credits)) c.add('economics');
  if (!same(prev.models, next.models)) c.add('models');
  if (!same(prev.verification, next.verification) || !same(prev.verification_config, next.verification_config)) c.add('verification');
  const rest = (m: ManifestV1) => {
    const { permissions: _a, harness: _b, coordinator: _c, data_policy: _d, credits: _e, models: _f, verification: _g, verification_config: _h, signatures: _i, ...r } = m;
    return r;
  };
  if (!same(rest(prev), rest(next))) c.add('other');
  return [...c];
}

/**
 * Changes that need platform review and stop work until affected users approve again
 * (SPEC 6.4, 11.4). A release that only narrows permissions still needs review but not
 * reconsent; this returns true whenever any reviewed category changed, the conservative reading.
 */
export function requiresReviewAndReconsent(changes: ReleaseChange[]): boolean {
  return changes.some((c) => c === 'permissions' || c === 'harness' || c === 'coordinator' || c === 'data_policy' || c === 'network' || c === 'economics');
}
