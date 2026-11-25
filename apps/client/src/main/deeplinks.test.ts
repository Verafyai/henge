import { describe, expect, it } from 'vitest';
import { deepLinkFromArgv, parseDeepLink } from './deeplinks';

describe('parseDeepLink (SPEC 4.4)', () => {
  it.each([
    ['swarmexplorer://swarm/challenge-vaults', { name: 'swarm', slug: 'challenge-vaults' }],
    ['swarmexplorer://join/verafy-dao-juries', { name: 'join', slug: 'verafy-dao-juries' }],
    ['swarmexplorer://model/qwen2.5-coder-7b', { name: 'model', slug: 'qwen2.5-coder-7b' }],
    ['swarmexplorer://harness/lean-prover', { name: 'harness', slug: 'lean-prover' }],
    ['swarmexplorer://result/01936f3e-0000-7000-8000-000000000001', { name: 'result', id: '01936f3e-0000-7000-8000-000000000001' }],
    ['swarmexplorer://publisher', { name: 'publisher' }],
  ])('navigates for %s', (url, route) => {
    expect(parseDeepLink(url)).toEqual({ kind: 'navigate', route });
  });

  it('passes the auth callback through for the auth manager', () => {
    expect(parseDeepLink('swarmexplorer://auth/callback?code=c&state=s')).toMatchObject({ kind: 'auth-callback' });
  });

  it.each([
    'https://swarm/challenge-vaults',
    'swarmstarter://p/owr-remake',
    'swarmexplorer://swarm/Challenge Vaults',
    'swarmexplorer://join/challenge-vaults?confirm=1',
    'swarmexplorer://join/challenge-vaults/now',
    'swarmexplorer://swarm/challenge-vaults?token=abc',
    'swarmexplorer://model/qwen2.5-coder-7b?install=1',
    'swarmexplorer://wallet',
    'swarmexplorer://wallet/send?to=x',
    'swarmexplorer://publisher/fund?credits=500',
    'swarmexplorer://auth/callback?code=c&state=s&access_token=t',
    'swarmexplorer://user:pw@swarm/challenge-vaults',
    'swarmexplorer://swarm/%E0%A4%A',
    'swarmexplorer://swarm',
    `swarmexplorer://swarm/${'a'.repeat(2000)}`,
  ])('ignores %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('finds a link in argv', () => {
    expect(deepLinkFromArgv(['/app', '--flag', 'swarmexplorer://publisher'])).toBe('swarmexplorer://publisher');
    expect(deepLinkFromArgv(['/app', 'swarmstarter://wallet'])).toBeNull();
  });
});
