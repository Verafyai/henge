import { describe, expect, it } from 'vitest';
import { deepLinkFromArgv, parseDeepLink } from './deeplinks';

describe('parseDeepLink (SPEC 4.4)', () => {
  it.each([
    ['henge://swarm/challenge-vaults', { name: 'swarm', slug: 'challenge-vaults' }],
    ['henge://join/verafy-dao-juries', { name: 'join', slug: 'verafy-dao-juries' }],
    ['henge://model/phi4-14b', { name: 'model', slug: 'phi4-14b' }],
    ['henge://harness/lean-prover', { name: 'harness', slug: 'lean-prover' }],
    ['henge://result/01936f3e-0000-7000-8000-000000000001', { name: 'result', id: '01936f3e-0000-7000-8000-000000000001' }],
    ['henge://publisher', { name: 'publisher' }],
  ])('navigates for %s', (url, route) => {
    expect(parseDeepLink(url)).toEqual({ kind: 'navigate', route });
  });

  it('passes the auth callback through for the auth manager', () => {
    expect(parseDeepLink('henge://auth/callback?code=c&state=s')).toMatchObject({ kind: 'auth-callback' });
  });

  it.each([
    'https://swarm/challenge-vaults',
    'swarmstarter://p/owr-remake',
    'henge://swarm/Challenge Vaults',
    'henge://join/challenge-vaults?confirm=1',
    'henge://join/challenge-vaults/now',
    'henge://swarm/challenge-vaults?token=abc',
    'henge://model/phi4-14b?install=1',
    'henge://wallet',
    'henge://wallet/send?to=x',
    'henge://publisher/fund?credits=500',
    'henge://auth/callback?code=c&state=s&access_token=t',
    'henge://user:pw@swarm/challenge-vaults',
    'henge://swarm/%E0%A4%A',
    'henge://swarm',
    `henge://swarm/${'a'.repeat(2000)}`,
  ])('ignores %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('henge://add?url= opens the join card for an https .henge link and nothing else', () => {
    const url = 'https://github.com/example-org/resolved-forecasts/blob/main/resolved-forecasts.henge.yaml';
    expect(parseDeepLink(`henge://add?url=${encodeURIComponent(url)}`)).toEqual({ kind: 'navigate', route: { name: 'add-henge', url } });
    for (const bad of [
      'henge://add',
      'henge://add?url=http%3A%2F%2Fexample.org%2Fa.henge',
      'henge://add?url=file%3A%2F%2F%2Fetc%2Fpasswd',
      `henge://add?url=${encodeURIComponent(url)}&join=1`,
      `henge://add?url=${encodeURIComponent(url)}&url=${encodeURIComponent(url)}`,
      `henge://add/now?url=${encodeURIComponent(url)}`,
      'henge://add?url=https%3A%2F%2Fu%3Ap%40example.org%2Fa.henge',
    ])
      expect(parseDeepLink(bad)).toBeNull();
  });

  it('finds a link in argv', () => {
    expect(deepLinkFromArgv(['/app', '--flag', 'henge://publisher'])).toBe('henge://publisher');
    expect(deepLinkFromArgv(['/app', 'swarmstarter://wallet'])).toBeNull();
  });
});
