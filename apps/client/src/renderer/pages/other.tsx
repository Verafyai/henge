import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { UpdateStatus } from '../../shared/bridge';
import { useAppInfo, useAuth, useMe, useNode, useNodeActions } from '../api';
import { HardwareSummary, RunRulesSummary } from './setup';
import type { NodeOverview, SandboxCheck } from '../../shared/node';
import { useNav } from '../router';
import { Btn } from '../ui/bits';

function Page({ title, intro, children }: { title: string; intro: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-[960px] px-6 py-8">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="mt-2 text-zinc-600">{intro}</p>
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}

export function PlaceholderPage({ title, body }: { title: string; body: string }) {
  const { go } = useNav();
  return (
    <Page title={title} intro={body}>
      <Btn variant="quiet" className="px-4 py-2 text-sm" onClick={() => go({ name: 'store' })}>
        Back to the Store
      </Btn>
    </Page>
  );
}

const fmt = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Settings > Node > Sandbox (SPEC 11.3, 16.4 M3): runs hostile test harnesses on this computer and
 * shows that each is stopped: no keys, files or unlisted domains; limits end the task; the bundle's
 * system prompt and output schema hold against injection.
 */
function SandboxSettings() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SandboxCheck[] | null>(null);
  const passed = results?.filter((r) => r.passed).length ?? 0;
  return (
    <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm" role="group" aria-label="Sandbox">
      <div className="flex items-center justify-between">
        <p>Harnesses run in a sandbox with no access to your keys, files or unlisted websites.</p>
        <Btn
          variant="quiet"
          className="px-3 py-1 text-xs"
          disabled={running}
          onClick={async () => {
            setRunning(true);
            setResults(await window.swarm.node.sandboxCheck());
            setRunning(false);
          }}
        >
          {running ? 'Checking' : 'Run sandbox checks'}
        </Btn>
      </div>
      {results && (
        <>
          <p className="mt-2 font-semibold" role="status" aria-label="Sandbox result">
            {passed === results.length ? `All ${results.length} checks passed.` : `${results.length - passed} of ${results.length} checks failed.`}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs" aria-label="Sandbox checks">
            {results.map((r) => (
              <li key={r.id} className={r.passed ? 'text-zinc-700' : 'text-red-700'}>
                {r.passed ? 'Passed' : 'Failed'}: {r.title}
                {!r.passed && ` (${r.detail})`}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Settings > Storage (SPEC 4.2): disk budget and what uses it. */
function StorageSettings({ o }: { o: NodeOverview }) {
  const { go } = useNav();
  const [gbText, setGbText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const st = o.models.storage;
  const GB = 1024 ** 3;
  return (
    <div className="mt-3 rounded-lg bg-zinc-50 p-3 text-sm" aria-label="Storage" role="group">
      <p data-testid="settings-storage">
        {st.diskBudgetBytes ? `Disk budget ${Math.round(st.diskBudgetBytes / GB)} GB, ${Math.round((o.models.usedBytes / GB) * 10) / 10} GB used by ${o.models.installed.filter((m) => m.managed).length} downloaded models.` : 'No disk budget yet. It is set at your first model download.'}{' '}
        <button type="button" className="text-brand hover:underline" onClick={() => go({ name: 'models' })}>
          Manage models
        </button>
      </p>
      <label className="mt-2 flex items-center gap-2">
        <span>Change disk budget (GB)</span>
        <input type="number" min={1} value={gbText} onChange={(e) => setGbText(e.target.value)} className="w-24 rounded border border-zinc-300 px-2 py-1" />
        <Btn
          variant="quiet"
          className="px-3 py-1 text-xs"
          disabled={!(Number(gbText) > 0)}
          onClick={async () => {
            const r = await window.swarm.models.setDiskBudget(Math.round(Number(gbText) * GB));
            setMsg(r.ok ? 'Saved.' : r.message);
          }}
        >
          Save budget
        </Btn>
      </label>
      {msg && <p className="mt-1 text-xs" role="status">{msg}</p>}
    </div>
  );
}

/** Settings > Node (SPEC 4.2): mode, detected sources, run rules with their enforcement, Pause. */
function NodeSettings() {
  const node = useNode();
  const actions = useNodeActions();
  const { go } = useNav();
  const o = node.data;
  if (!o) return null;
  return (
    <section aria-labelledby="s-node" className="rounded-xl border border-zinc-200 p-5">
      <div className="flex items-center justify-between">
        <h2 id="s-node" className="font-semibold">
          Node
        </h2>
        <div className="flex gap-2">
          <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => void actions.detect()}>
            Check hardware again
          </Btn>
          <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={() => void actions.setPaused(!o.paused)}>
            {o.paused ? 'Resume node' : 'Pause node'}
          </Btn>
        </div>
      </div>
      <p className="mt-1 text-sm text-zinc-600">
        {o.setup ? `Mode ${o.setup.mode}, cause ${o.setup.swarm}.` : 'Not set up yet.'}{' '}
        <button type="button" className="text-brand hover:underline" onClick={() => go({ name: 'setup' })}>
          {o.setup ? 'Change cause or mode' : 'Pick a cause'}
        </button>
      </p>
      <p className="mt-1 text-xs text-zinc-500" data-testid="node-registration">
        {o.registration ? (o.registration.capabilitiesReportedAt ? `Hardware summary shared ${fmt.format(new Date(o.registration.capabilitiesReportedAt))}` : 'Node registered') : 'Sign in to register this node.'}
      </p>
      <StorageSettings o={o} />
      <SandboxSettings />
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <HardwareSummary o={o} />
        <RunRulesSummary o={o} />
      </div>
    </section>
  );
}

export function SettingsPage() {
  const info = useAppInfo();
  const auth = useAuth();
  const me = useMe();
  const qc = useQueryClient();
  const installs = useQuery({ queryKey: ['installs'], enabled: auth.status === 'signed_in', queryFn: () => window.swarm.account.installs() });
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  return (
    <Page title="Settings" intro="Account, devices, updates and this build.">
      <section aria-labelledby="s-account" className="rounded-xl border border-zinc-200 p-5">
        <h2 id="s-account" className="font-semibold">
          Account
        </h2>
        {auth.status === 'signed_in' && me.data ? (
          <div className="mt-2 flex items-center justify-between">
            <p className="text-sm">
              Signed in as <b>{me.data.displayName}</b> (@{me.data.handle}). Your sign in is stored in the system keychain.
            </p>
            <Btn variant="quiet" className="px-3 py-1.5 text-sm" onClick={async () => qc.setQueryData(['auth'], await window.swarm.auth.signOut())}>
              Sign out
            </Btn>
          </div>
        ) : (
          <div className="mt-2 flex items-center justify-between">
            <p className="text-sm text-zinc-600">Signed out. Sign in opens your web browser.</p>
            <Btn
              className="px-3 py-1.5 text-sm"
              disabled={auth.status === 'signing_in'}
              onClick={async () => {
                qc.setQueryData(['auth'], { status: 'signing_in' });
                qc.setQueryData(['auth'], await window.swarm.auth.signIn());
              }}
            >
              {auth.status === 'signing_in' ? 'Finish in your browser' : 'Sign in'}
            </Btn>
          </div>
        )}
      </section>

      {auth.status === 'signed_in' && (
        <section aria-labelledby="s-devices" className="rounded-xl border border-zinc-200 p-5">
          <h2 id="s-devices" className="font-semibold">
            Signed in devices
          </h2>
          <ul className="mt-2 divide-y divide-zinc-100 text-sm">
            {(installs.data ?? [])
              .filter((d) => !d.revokedAt)
              .map((d) => (
                <li key={d.id} className="flex items-center justify-between py-2">
                  <span>
                    <b>
                      {d.platform} {d.arch}
                    </b>{' '}
                    · v{d.version} ({d.channel}) · last seen {fmt.format(new Date(d.lastSeenAt))}
                    {d.current && <span className="ml-2 text-brand">This computer</span>}
                  </span>
                  <Btn
                    variant="quiet"
                    className="px-3 py-1 text-xs"
                    onClick={async () => {
                      await window.swarm.account.revokeInstall(d.id);
                      void qc.invalidateQueries({ queryKey: ['installs'] });
                    }}
                  >
                    Sign out
                  </Btn>
                </li>
              ))}
          </ul>
        </section>
      )}

      <NodeSettings />

      <section aria-labelledby="s-updates" className="rounded-xl border border-zinc-200 p-5">
        <h2 id="s-updates" className="font-semibold">
          Updates
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Version {info.data?.version} on the {info.data?.channel === 'dev' ? 'development (follows internal)' : info.data?.channel} channel. Updates are verified
          with a signed manifest before they are offered.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Btn
            variant="quiet"
            className="px-3 py-1.5 text-sm"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setUpdate(await window.swarm.updates.check());
              setChecking(false);
            }}
          >
            {checking ? 'Checking' : 'Check for updates'}
          </Btn>
          {update && (
            <p role="status" data-testid="update-status" className={update.kind === 'rejected' || update.kind === 'error' ? 'text-sm text-red-700' : 'text-sm text-ink'}>
              {update.message}
            </p>
          )}
        </div>
      </section>

      <section aria-labelledby="s-about" className="rounded-xl border border-zinc-200 p-5 text-sm">
        <h2 id="s-about" className="font-semibold">
          About this build
        </h2>
        <p className="mt-1 text-zinc-600">
          API {info.data?.apiBaseUrl} · {info.data?.platform} {info.data?.arch} · {info.data?.isPackaged ? 'packaged' : 'unpackaged development run'}
        </p>
      </section>
    </Page>
  );
}

/** Pages reserved by SPEC 4.1 that later milestones fill in (SPEC 16.4). */
export const PLANNED_PAGES = {
  library: { title: 'Library', body: 'Your joined swarms, their shares and per-swarm pause and leave. Joining arrives in milestone M4.' },
  activity: { title: 'Activity', body: 'Your node timeshare, queue and run history. Task leasing arrives in milestone M5; until then nothing runs.' },
  community: { title: 'Community', body: 'Profiles, teams and result discussions arrive in milestone M10.' },
  wallet: { title: 'Wallet', body: 'Credits earned for verified work in funded swarms, and impact from volunteer swarms. The ledger view arrives in milestone M6.' },
  publisher: { title: 'Publisher Studio', body: 'Publisher identity, pools and the release dashboard arrive in milestone M9.' },
} as const;
