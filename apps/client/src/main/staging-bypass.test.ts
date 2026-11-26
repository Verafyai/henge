import { afterEach, describe, expect, it } from 'vitest';
import { BYPASS_HEADER, installStagingBypass, withStagingBypass } from './staging-bypass';

const API = 'https://web-git-staging-verafyai.vercel.app';

function recorder() {
  const seen: Array<{ url: string; header: string | null; auth: string | null }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    seen.push({ url, header: h.get(BYPASS_HEADER), auth: h.get('authorization') });
    return new Response('ok');
  }) as typeof fetch;
  return { f, seen };
}

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe('staging protection bypass for test nodes', () => {
  it('adds the header only for the API origin and keeps other headers', async () => {
    const { f, seen } = recorder();
    const wrapped = withStagingBypass(f, API, 'test-secret');
    await wrapped(`${API}/v1/coordinators/x/leases`, { method: 'POST', headers: { authorization: 'Bearer t' } });
    await wrapped('https://registry.ollama.ai/v2/library/phi4/manifests/14b-q4_K_M');
    await wrapped('https://huggingface.co/x');
    await wrapped(new Request(`${API}/v1/health`));
    expect(seen).toEqual([
      { url: `${API}/v1/coordinators/x/leases`, header: 'test-secret', auth: 'Bearer t' },
      { url: 'https://registry.ollama.ai/v2/library/phi4/manifests/14b-q4_K_M', header: null, auth: null },
      { url: 'https://huggingface.co/x', header: null, auth: null },
      { url: `${API}/v1/health`, header: 'test-secret', auth: null },
    ]);
  });

  it('is never installed in packaged builds, without the secret, or for a non-https API', () => {
    expect(installStagingBypass({ isPackaged: true, apiBaseUrl: API, env: { HENGE_VERCEL_BYPASS: 's' } })).toBe(false);
    expect(installStagingBypass({ isPackaged: false, apiBaseUrl: API, env: {} })).toBe(false);
    expect(installStagingBypass({ isPackaged: false, apiBaseUrl: 'http://localhost:3000', env: { HENGE_VERCEL_BYPASS: 's' } })).toBe(false);
    expect(globalThis.fetch).toBe(original);
  });

  it('installs for an unpackaged run against staging', () => {
    expect(installStagingBypass({ isPackaged: false, apiBaseUrl: API, env: { HENGE_VERCEL_BYPASS: 's' } })).toBe(true);
    expect(globalThis.fetch).not.toBe(original);
  });
});
