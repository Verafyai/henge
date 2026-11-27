import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { LocalHenge } from '../../shared/henge';
import { useNode } from '../api';
import { InMemoryCommunityStore } from '../community/memory';
import type { CommunityStore, Presence } from '../community/store';

/**
 * The one place a CommunityStore is created. Dev and test builds use the in-memory store; the
 * community server client (packages/api-client/src/community.ts) replaces it here once it lands.
 */
export function createCommunityStore(): CommunityStore {
  return new InMemoryCommunityStore();
}

const StoreContext = createContext<CommunityStore | null>(null);

export function CommunityProvider({ store, children }: { store: CommunityStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The community store; re-renders the caller after any change. */
export function useCommunity(): CommunityStore {
  const s = useContext(StoreContext);
  if (!s) throw new Error('useCommunity outside CommunityProvider');
  const subscribe = useCallback((l: () => void) => s.subscribe(l), [s]);
  useSyncExternalStore(subscribe, () => s.version());
  return s;
}

export function useLocalHenges() {
  return useQuery({ queryKey: ['henges'], queryFn: () => window.swarm.henges.list(), staleTime: Infinity });
}

export function useSetHenge() {
  const qc = useQueryClient();
  return (h: LocalHenge) => qc.setQueryData<LocalHenge[]>(['henges'], (cur) => [...(cur ?? []).filter((x) => x.key !== h.key), h]);
}

export function useGlyphCatalog() {
  return useQuery({ queryKey: ['glyph-catalog'], queryFn: () => window.swarm.henges.glyphCatalog(), staleTime: Infinity });
}

export const myRoleIn = (h: LocalHenge) => (h.status === 'owner' ? 'owner' : 'member');

/** Keeps the store's spaces and agent presence in step with the files and the local node. */
export function useCommunitySync() {
  const store = useCommunity();
  const henges = useLocalHenges();
  const node = useNode();
  useEffect(() => {
    for (const h of henges.data ?? []) store.attachHenge({ hengeId: h.key, henge: h.henge, myRole: myRoleIn(h) });
  }, [henges.data, store]);
  const o = node.data;
  const presence: Presence = !o || o.kill.global || !o.setup ? 'offline' : o.paused ? 'paused' : 'running';
  useEffect(() => store.setAgentPresence(presence), [presence, store]);
}

/* Local UI state shared by the layout: modals and the profile popover. */
type Ui = {
  addGlyph: string | null;
  openAddGlyph: (key: string | null) => void;
  profile: { memberId: string; x: number; y: number } | null;
  openProfile: (p: { memberId: string; x: number; y: number } | null) => void;
};
const UiContext = createContext<Ui | null>(null);
export function UiProvider({ children }: { children: ReactNode }) {
  const [addGlyph, openAddGlyph] = useState<string | null>(null);
  const [profile, openProfile] = useState<Ui['profile']>(null);
  return <UiContext.Provider value={{ addGlyph, openAddGlyph, profile, openProfile }}>{children}</UiContext.Provider>;
}
export function useUi(): Ui {
  const v = useContext(UiContext);
  if (!v) throw new Error('useUi outside UiProvider');
  return v;
}

/** Onboarding choices kept in this profile's local storage (not secrets). */
export const prefs = {
  get(k: 'local-mode' | 'profile-skipped'): boolean {
    try {
      return localStorage.getItem(`henge.${k}`) === '1';
    } catch {
      return false;
    }
  },
  set(k: 'local-mode' | 'profile-skipped', v: boolean) {
    try {
      if (v) localStorage.setItem(`henge.${k}`, '1');
      else localStorage.removeItem(`henge.${k}`);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  },
};
