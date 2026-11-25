import { createApiClient, type ApiClient } from '@swarm-explorer/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AuthState } from '../shared/bridge';

let clientPromise: Promise<ApiClient> | null = null;

/** The API base URL comes from the main process, never from the renderer's own config. */
export function getClient() {
  clientPromise ??= window.swarm.getAppInfo().then((info) => createApiClient({ baseUrl: info.apiBaseUrl }));
  return clientPromise;
}

export function useAppInfo() {
  return useQuery({ queryKey: ['app-info'], queryFn: () => window.swarm.getAppInfo(), staleTime: Infinity });
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: async () => (await getClient()).health(), refetchInterval: 15_000, retry: false });
}

export function useSwarms() {
  return useQuery({ queryKey: ['swarms'], queryFn: async () => (await (await getClient()).listSwarms()).items });
}

export function useSwarm(slug: string | undefined) {
  return useQuery({ queryKey: ['swarm', slug], enabled: Boolean(slug), queryFn: async () => (await getClient()).getSwarm(slug!) });
}

export function useModels() {
  return useQuery({ queryKey: ['models'], queryFn: async () => (await (await getClient()).listModels()).items });
}

/** Auth state lives in the main process; this mirrors it and refetches account data on change. */
export function useAuth() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['auth'], queryFn: () => window.swarm.auth.getState(), staleTime: Infinity });
  useEffect(
    () =>
      window.swarm.auth.onChanged((s: AuthState) => {
        qc.setQueryData(['auth'], s);
        void qc.invalidateQueries({ queryKey: ['me'] });
        void qc.invalidateQueries({ queryKey: ['installs'] });
      }),
    [qc],
  );
  return q.data ?? { status: 'signed_out' as const };
}

export function useMe() {
  const auth = useAuth();
  return useQuery({ queryKey: ['me'], enabled: auth.status === 'signed_in', queryFn: () => window.swarm.account.me() });
}

export function useRecent() {
  return useQuery({ queryKey: ['recent'], queryFn: () => window.swarm.recent.list(), staleTime: Infinity });
}

export function useRecordView() {
  const qc = useQueryClient();
  return async (slug: string) => qc.setQueryData(['recent'], await window.swarm.recent.add(slug));
}

/** Node overview from the main process, kept live by its change events. */
export function useNode() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['node'], queryFn: () => window.swarm.node.overview(), staleTime: Infinity });
  useEffect(() => window.swarm.node.onChanged((o) => qc.setQueryData(['node'], o)), [qc]);
  return q;
}

export function useNodeActions() {
  const qc = useQueryClient();
  const set = (o: Awaited<ReturnType<typeof window.swarm.node.overview>> | null) => {
    if (o) qc.setQueryData(['node'], o);
    return o;
  };
  return {
    detect: async () => set(await window.swarm.node.detect()),
    saveSetup: async (s: Parameters<typeof window.swarm.node.saveSetup>[0]) => set(await window.swarm.node.saveSetup(s)),
    resetSetup: async () => set(await window.swarm.node.resetSetup()),
    setPaused: async (p: boolean) => set(await window.swarm.node.setPaused(p)),
  };
}
