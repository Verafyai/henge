import type { z } from 'zod';
import {
  apiErrorSchema,
  harnessReleaseSchema,
  healthSchema,
  modelListSchema,
  publicResultsSchema,
  receiptKeysSchema,
  revocationFeedSchema,
  swarmDetailSchema,
  swarmListSchema,
  type ListSwarmsQuery,
} from './contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  /** Returns a bearer token, or null when signed out. Never logged. */
  getAccessToken?: () => Promise<string | null> | string | null;
  fetch?: typeof fetch;
};

/**
 * Typed REST client for /v1 (SPEC 13). Every response is parsed with the shared
 * Zod contract, so server drift fails loudly instead of rendering garbage.
 */
export function createApiClient(opts: ApiClientOptions) {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;

  async function request<S extends z.ZodType>(schema: S, path: string, init: RequestInit = {}): Promise<z.output<S>> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    const token = await opts.getAccessToken?.();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await doFetch(`${base}/v1${path}`, { ...init, headers });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = apiErrorSchema.safeParse(body);
      throw err.success
        ? new ApiError(res.status, err.data.error.code, err.data.error.message, err.data.error.details)
        : new ApiError(res.status, 'http_error', `Request failed with status ${res.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(res.status, 'bad_response', 'The server sent a response this client does not understand.');
    return parsed.data;
  }

  const q = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    const s = sp.toString();
    return s ? `?${s}` : '';
  };

  return {
    health: () => request(healthSchema, '/health'),
    listSwarms: (query: ListSwarmsQuery = {}) => request(swarmListSchema, `/swarms${q({ category: query.category })}`),
    getSwarm: (slug: string) => request(swarmDetailSchema, `/swarms/${encodeURIComponent(slug)}`),
    listModels: () => request(modelListSchema, '/models'),
    harnessRelease: (name: string, version: string) =>
      request(harnessReleaseSchema, `/harnesses/${encodeURIComponent(name)}/releases/${encodeURIComponent(version)}`),
    revocations: (since?: string) => request(revocationFeedSchema, `/revocations${q({ since })}`),
    swarmResults: (slug: string) => request(publicResultsSchema, `/swarms/${encodeURIComponent(slug)}/results`),
    receiptKeys: () => request(receiptKeysSchema, '/receipts/keys'),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
