import { cn, StatusBar } from '@swarm-explorer/ui';
import hengeMark from '../assets/henge-mark.svg';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppInfo, useAuth, useHealth, useMe, useNode, useNodeActions, useSwarms } from '../api';
import { tabOf, useNav } from '../router';
import { initials } from '../view';

const TABS = [
  { key: 'store', label: 'Store', route: { name: 'store' } },
  { key: 'library', label: 'Library', route: { name: 'library' } },
  { key: 'activity', label: 'Activity', route: { name: 'activity' } },
  { key: 'community', label: 'Community', route: { name: 'community' } },
  { key: 'wallet', label: 'Wallet', route: { name: 'wallet' } },
] as const;

/** macOS only: the window has an inset title bar, so we draw the strip (client-store.png). */
function TitleStrip({ online }: { online: boolean }) {
  const info = useAppInfo();
  if (info.data?.platform !== 'darwin') return null;
  return (
    <div className="app-drag flex h-9 shrink-0 items-center border-b border-zinc-200 bg-zinc-100 pl-20 pr-4 text-xs text-zinc-500">
      <span className="flex-1 text-center">
        Henge v{info.data.version} ({info.data.channel})
      </span>
      <span className="flex items-center gap-1.5" data-testid="api-status">
        <span aria-hidden="true" className={online ? 'size-2 rounded-full bg-live' : 'size-2 rounded-full border border-zinc-400'} />
        {online ? 'Online' : 'Offline'}
      </span>
    </div>
  );
}

function Search() {
  const { go } = useNav();
  const swarms = useSwarms();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return (swarms.data ?? []).filter((p) => `${p.name} ${p.summary} ${p.category}`.toLowerCase().includes(t)).slice(0, 6);
  }, [q, swarms.data]);
  return (
    <div className="relative w-[220px]">
      <input
        type="search"
        aria-label="Search swarms"
        placeholder="Search swarms"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            go({ name: 'swarm', slug: results[0].slug });
            setQ('');
            setOpen(false);
          }
          if (e.key === 'Escape') setOpen(false);
        }}
        className="w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-sm outline-none focus:border-brand"
      />
      {open && q.trim() && (
        <ul role="listbox" aria-label="Search results" className="absolute right-0 top-10 z-40 w-[320px] overflow-hidden rounded-xl border border-zinc-200 bg-surface py-1 shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No swarms match.</li>}
          {results.map((p) => (
            <li key={p.slug} role="option" aria-selected="false">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  go({ name: 'swarm', slug: p.slug });
                  setQ('');
                  setOpen(false);
                }}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-50"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{p.name}</span>
                  <span className="block truncate text-xs text-zinc-500">{p.summary}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Popover({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className={cn('absolute right-0 top-11 z-40 rounded-xl border border-zinc-200 bg-surface shadow-lg', className)}>
      {children}
    </div>
  );
}

function Account() {
  const auth = useAuth();
  const me = useMe();
  const { go } = useNav();
  const qc = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [bell, setBell] = useState(false);

  const signIn = async () => {
    qc.setQueryData(['auth'], { status: 'signing_in' });
    qc.setQueryData(['auth'], await window.swarm.auth.signIn());
  };

  return (
    <div className="relative flex items-center gap-3 whitespace-nowrap">
      <Search />
      <button
        type="button"
        aria-label="Notifications"
        aria-expanded={bell}
        onClick={() => setBell((b) => !b)}
        className="grid size-8 place-items-center rounded-lg border border-zinc-200 text-zinc-600 hover:border-brand"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </button>
      <Popover open={bell} onClose={() => setBell(false)} className="w-80 p-4">
        <h2 className="font-semibold text-ink">Notifications</h2>
        <p className="mt-2 text-sm text-zinc-600">Nothing yet. Qualification results, verified work and release changes that need your consent will show up here.</p>
      </Popover>

      {auth.status === 'signed_in' && me.data ? (
        <>
          <button type="button" aria-label="Account menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-xs text-white">
              {initials(me.data.displayName)}
            </span>
            {me.data.handle}
          </button>
          <Popover open={menu} onClose={() => setMenu(false)} className="w-56 py-1">
            <p className="border-b border-zinc-100 px-4 py-2 text-xs text-zinc-500">
              Signed in as <b className="text-ink">{me.data.displayName}</b>
            </p>
            <button type="button" className="block w-full px-4 py-2 text-left text-sm hover:bg-zinc-50" onClick={() => (setMenu(false), go({ name: 'settings' }))}>
              Settings
            </button>
            <button
              type="button"
              className="block w-full px-4 py-2 text-left text-sm hover:bg-zinc-50"
              onClick={async () => {
                setMenu(false);
                qc.setQueryData(['auth'], await window.swarm.auth.signOut());
              }}
            >
              Sign out
            </button>
          </Popover>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void signIn()}
          disabled={auth.status === 'signing_in'}
          className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-70"
        >
          {auth.status === 'signing_in' ? 'Finish in your browser' : 'Sign in'}
        </button>
      )}
    </div>
  );
}

function TopBar() {
  const { route, go, back, forward, canBack, canForward } = useNav();
  const active = tabOf(route);
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-teal-400/40 bg-surface px-4">
      <button type="button" onClick={() => go({ name: 'store' })} className="mr-4 flex items-center gap-2 whitespace-nowrap" aria-label="Henge by Verafy, Store">
        <img src={hengeMark} alt="" className="h-7 w-auto" />
        <span className="flex flex-col leading-none">
          <span className="text-[15px] font-bold tracking-[0.18em]">HENGE</span>
          <span className="mt-0.5 font-mono text-[10px] text-ink-muted">
            <span className="text-accent">//</span> by Verafy
          </span>
        </span>
      </button>
      <button type="button" aria-label="Back" disabled={!canBack} onClick={back} className="px-1 text-lg text-zinc-500 disabled:text-zinc-300">
        &#8249;
      </button>
      <button type="button" aria-label="Forward" disabled={!canForward} onClick={forward} className="mr-3 px-1 text-lg text-zinc-500 disabled:text-zinc-300">
        &#8250;
      </button>
      <nav aria-label="Main" className="flex h-full">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-current={active === t.key ? 'page' : undefined}
            onClick={() => go(t.route)}
            className={cn(
              'flex h-12 items-center px-4 text-[13px] font-semibold uppercase tracking-wide',
              active === t.key ? 'border-b-2 border-brand text-brand' : 'text-zinc-600 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      <Account />
    </header>
  );
}

function Notices() {
  const [msgs, setMsgs] = useState<Array<{ id: number; text: string }>>([]);
  useEffect(
    () =>
      window.swarm.onNotice((text) => {
        const id = Date.now() + Math.random();
        setMsgs((m) => [...m, { id, text }]);
        setTimeout(() => setMsgs((m) => m.filter((x) => x.id !== id)), 6000);
      }),
    [],
  );
  if (!msgs.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-14 right-4 z-50 space-y-2" aria-live="polite">
      {msgs.map((m) => (
        <p key={m.id} role="status" className="rounded-lg bg-toast px-4 py-2 text-sm text-white shadow-lg">
          {m.text}
        </p>
      ))}
    </div>
  );
}

const MODE_LABEL = { local: 'Local', api: 'API key', hybrid: 'Hybrid' } as const;

/**
 * Header status (SPEC 4.1): node status, mode, active model, spend today and one Pause button.
 * States are specific; nothing here claims work is running when it is not (SPEC 4.2).
 */
function NodeStatus({ online }: { online: boolean }) {
  const node = useNode();
  const actions = useNodeActions();
  const o = node.data;
  const setup = o?.setup ?? null;
  const paused = o?.paused ?? false;
  const state = paused
    ? { label: 'Paused', tone: 'paused' as const, detail: 'nothing will run until you resume' }
    : setup
      ? { label: 'Set up', tone: online ? ('idle' as const) : ('offline' as const), detail: 'no swarm joined yet' }
      : { label: 'Node not set up', tone: online ? ('idle' as const) : ('offline' as const), detail: 'nothing runs on this computer yet' };
  return (
    <StatusBar
      state={state}
      items={[
        { key: 'mode', value: setup ? `Mode: ${MODE_LABEL[setup.mode]}` : 'Mode: not chosen' },
        { key: 'model', value: `Model: ${o?.models.installed.find((m) => m.contentHash === o.models.storage.activeModel)?.displayName ?? 'none'}` },
        { key: 'spend', value: 'API spend today: none' },
        { key: 'net', value: online ? 'Catalog online' : 'Offline: showing cached data' },
      ]}
      note="Example data"
      action={
        <button type="button" onClick={() => void actions.setPaused(!paused)} className="rounded border border-bar-line px-2 py-0.5 text-bar-ink hover:border-white hover:text-white">
          {paused ? 'Resume' : 'Pause'}
        </button>
      }
    />
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const health = useHealth();
  const online = health.isSuccess;
  const auth = useAuth();
  return (
    <div className="flex h-full flex-col">
      <TitleStrip online={online} />
      <TopBar />
      {auth.error && auth.status === 'signed_out' && (
        <p role="alert" className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {auth.error}
        </p>
      )}
      <main className="min-h-0 flex-1 overflow-y-auto" id="content">
        {children}
      </main>
      <NodeStatus online={online} />
      <Notices />
    </div>
  );
}
