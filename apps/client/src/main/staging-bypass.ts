/**
 * Test nodes reach the protected staging deployment with Vercel's protection-bypass secret (approved by Rex,
 * 2026-11-25). The secret lives only in the test node's environment (`HENGE_VERCEL_BYPASS`), never in git or a build.
 *
 * Unpackaged runs only: packaged builds never read it. The header is added only to requests for the API's own
 * origin, so the secret never goes to model registries, Hugging Face or any other host.
 */
export const BYPASS_HEADER = 'x-vercel-protection-bypass';

export function withStagingBypass(base: typeof fetch, apiBaseUrl: string, secret: string): typeof fetch {
  const apiOrigin = new URL(apiBaseUrl).origin;
  return (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== apiOrigin) return base(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    headers.set(BYPASS_HEADER, secret);
    return base(input instanceof Request ? new Request(input, { ...init, headers }) : input, { ...init, headers });
  };
}

/** Installs the wrapper on the global fetch when, and only when, this is an unpackaged run with the secret set. */
export function installStagingBypass(opts: { isPackaged: boolean; apiBaseUrl: string; env: NodeJS.ProcessEnv }): boolean {
  const secret = opts.env['HENGE_VERCEL_BYPASS']?.trim();
  if (opts.isPackaged || !secret || !opts.apiBaseUrl.startsWith('https://')) return false;
  globalThis.fetch = withStagingBypass(globalThis.fetch.bind(globalThis), opts.apiBaseUrl, secret);
  return true;
}
