import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Route } from '../shared/routes';

type Nav = {
  route: Route;
  go: (r: Route) => void;
  back: () => void;
  forward: () => void;
  canBack: boolean;
  canForward: boolean;
};

const NavContext = createContext<Nav | null>(null);

/** In-memory history with back and forward, like a launcher. Deep links push onto it. */
export function RouterProvider({ children }: { children: ReactNode }) {
  const [h, setH] = useState<{ stack: Route[]; i: number }>({ stack: [{ name: 'store' }], i: 0 });

  const go = useCallback((r: Route) => {
    setH((cur) => {
      const top = cur.stack[cur.i];
      if (top && JSON.stringify(top) === JSON.stringify(r)) return cur;
      return { stack: [...cur.stack.slice(0, cur.i + 1), r].slice(-50), i: Math.min(cur.i + 1, 49) };
    });
  }, []);
  const back = useCallback(() => setH((cur) => ({ ...cur, i: Math.max(0, cur.i - 1) })), []);
  const forward = useCallback(() => setH((cur) => ({ ...cur, i: Math.min(cur.stack.length - 1, cur.i + 1) })), []);

  useEffect(() => {
    void window.swarm.takeLaunchRoute().then((r) => r && go(r));
    return window.swarm.onNavigate(go);
  }, [go]);

  // Mouse back and forward buttons, and Cmd or Alt plus arrows.
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back();
      if (e.button === 4) forward();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.altKey)) return;
      if (e.key === '[' || e.key === 'ArrowLeft') back();
      if (e.key === ']' || e.key === 'ArrowRight') forward();
    };
    window.addEventListener('mouseup', onMouse);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mouseup', onMouse);
      window.removeEventListener('keydown', onKey);
    };
  }, [back, forward]);

  const value = useMemo<Nav>(
    () => ({ route: h.stack[h.i]!, go, back, forward, canBack: h.i > 0, canForward: h.i < h.stack.length - 1 }),
    [h, go, back, forward],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const v = useContext(NavContext);
  if (!v) throw new Error('useNav outside RouterProvider');
  return v;
}

/** The tab a route belongs to, for the top bar (SPEC 4.1). */
export type Tab = 'store' | 'library' | 'activity' | 'community' | 'wallet';
export function tabOf(r: Route): Tab | null {
  switch (r.name) {
    case 'store':
    case 'swarm':
    case 'join':
    case 'model':
    case 'models':
    case 'harness':
    case 'result':
      return 'store';
    case 'reconsent':
      return 'library';
    case 'library':
    case 'activity':
    case 'community':
    case 'wallet':
      return r.name;
    default:
      return null;
  }
}
