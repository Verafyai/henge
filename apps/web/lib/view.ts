/** Display helpers. Swarm wording is shared with Henge through `@swarm-explorer/api-client/swarm-view`. */
export { formatDuration, joinAnd, permissionLines, policyLabel, rewardLine, swarmQuestions, verificationLabel } from '@swarm-explorer/api-client/swarm-view';

export function formatBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}
