import type { SwarmSummary } from '@swarm-explorer/api-client';
import { categories, categoryLabel } from '@swarm-explorer/core';
import { causeFit, enforcementLabel, memoryFacts, memoryFitLabel, recommendStarter, type Mode } from '@swarm-explorer/node-core';
import { Chip } from '@swarm-explorer/ui';
import { useState } from 'react';
import type { NodeOverview } from '../../shared/node';
import { useModels, useNode, useNodeActions, useSwarms } from '../api';
import { useNav } from '../router';
import { Btn, Empty, Eyebrow } from '../ui/bits';
import { permissionLines, rewardText, verificationLabel } from '../view';

const GIB = 1024 ** 3;
const gb = (n: number | null) => (n === null ? 'Unknown' : `${Math.round(n / GIB)} GB`);
const modeLabel: Record<Mode, string> = { local: 'Local', api: 'API key', hybrid: 'Hybrid' };
const modeBlurb: Record<Mode, string> = {
  local: 'Ollama or llama.cpp on this computer. Costs only your own electricity.',
  api: 'Your own provider key. Real per-task provider charges, shown before and after.',
  hybrid: 'Local first; API only for policy-required work you approve per swarm.',
};

/** What we found on this computer (SPEC 5.1 steps 1 and 2). */
export function HardwareSummary({ o }: { o: NodeOverview }) {
  const d = o.detection;
  if (!d) return <p className="text-sm text-zinc-500">Checking this computer</p>;
  const h = d.hardware;
  const gpu = o.recommendation?.local.gpu;
  return (
    <div className="space-y-3 text-sm">
      {d.fixture && <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">Test fixture: {d.fixture}</p>}
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1" aria-label="Detected hardware">
        <dt className="text-zinc-500">System</dt>
        <dd>{`${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux', other: 'Other' }[h.os.platform]} · ${h.cpu.appleSilicon ? 'Apple Silicon' : h.cpu.arch} · ${h.cpu.cores} cores`}</dd>
        <dt className="text-zinc-500">Memory</dt>
        <dd>{gb(h.ramBytes)}</dd>
        <dt className="text-zinc-500">GPU</dt>
        <dd>
          {gpu ? `${gpu.name}${gpu.memory === 'unified' ? ' (unified memory)' : gpu.vramBytes !== null ? `, ${gb(gpu.vramBytes)}${gpu.vramConfidence === 'estimated' ? ' or more' : ''}` : ', memory unknown'}` : h.confidence.gpu === 'unknown' ? 'Could not detect' : 'None found'}
        </dd>
        <dt className="text-zinc-500">Free disk</dt>
        <dd>{gb(h.freeDiskBytes)}</dd>
      </dl>
      <ul aria-label="Model runtimes" className="space-y-1">
        {d.runtimes.map((r) => (
          <li key={r.kind}>
            <b>{r.kind === 'ollama' ? 'Ollama' : 'llama.cpp'}</b>:{' '}
            {r.status === 'found' ? `found${r.version ? ` (${r.version})` : ''}${r.kind === 'ollama' ? `, ${r.models.length} ${r.models.length === 1 ? 'model' : 'models'} installed` : ''}` : r.status === 'not_found' ? 'not found' : (r.detail ?? 'not checked')}
            {r.kind === 'ollama' && r.models.length > 0 && <span className="block text-xs text-zinc-500">{r.models.map((m) => m.name).join(', ')}</span>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-zinc-500">Read-only check. Nothing was installed or changed.</p>
      {h.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-zinc-500">
          {h.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RunRulesSummary({ o }: { o: NodeOverview }) {
  return (
    <table className="w-full text-sm" aria-label="Run rules">
      <tbody>
        {o.runRules.map((r) => (
          <tr key={r.rule} className="border-b border-zinc-100 last:border-0">
            <th scope="row" className="py-1 pr-3 text-left font-normal text-zinc-500">{r.rule}</th>
            <td className="py-1">{r.value}</td>
            <td className={`py-1 text-right text-xs ${r.enforcement === 'enforced' ? 'text-brand' : 'text-zinc-500'}`}>{enforcementLabel[r.enforcement]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SwarmChoice({ s, onChoose }: { s: SwarmSummary; onChoose: () => void }) {
  return (
    <section aria-label="Featured cause" className="rounded-xl border border-zinc-200 bg-surface p-5">
      <span className="flex gap-1.5">
        <Chip tone="info">{categoryLabel(s.category)}</Chip>
        <Chip tone={s.funding.mode === 'funded' ? 'approved' : 'neutral'}>{s.funding.mode === 'funded' ? 'Funded' : 'Volunteer'}</Chip>
      </span>
      <h2 className="mt-2 text-xl font-bold">{s.name}</h2>
      <p className="text-xs text-zinc-500">by {s.publisher.name}</p>
      <p className="mt-2 text-zinc-700">{s.summary}</p>
      <dl className="mt-3 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-zinc-500">Reward</dt>
        <dd>{rewardText(s)}</dd>
        <dt className="text-zinc-500">Verified by</dt>
        <dd>{s.verification.map((v) => verificationLabel[v]).join(', ')}</dd>
        <dt className="text-zinc-500">Permissions</dt>
        <dd>{permissionLines(s.permissions).join('; ')}</dd>
        <dt className="text-zinc-500">API costs</dt>
        <dd>{s.models.apiAllowed ? 'None unless you set up an API key and approve it for this swarm' : 'None: local models only'}</dd>
      </dl>
      <Btn className="mt-4 px-4 py-2 text-sm" onClick={onChoose}>
        Choose this cause
      </Btn>
      <p className="mt-1 text-xs text-zinc-500">Choosing does not download, install or join anything.</p>
    </section>
  );
}

/** Pick a cause (SPEC 3.1): category, featured cause, detection and mode. Download and join follow with their own confirmations. */
export function SetupPage() {
  const node = useNode();
  const swarms = useSwarms();
  const models = useModels();
  const actions = useNodeActions();
  const { go } = useNav();
  const [category, setCategory] = useState<string | null>(node.data?.setup?.category ?? null);
  const [swarm, setSwarm] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const o = node.data;
  const all = swarms.data ?? [];
  const featured = category ? (all.find((s) => s.category === category && s.featured) ?? all.find((s) => s.category === category)) : undefined;
  const chosen = all.find((s) => s.slug === swarm);
  const rec = o?.recommendation ?? null;
  const effectiveMode = mode ?? rec?.preselect ?? null;
  const accepted = chosen ? (models.data ?? []).filter((m) => m.acceptedSwarms.includes(chosen.slug)).length : 0;
  const fit = chosen && rec ? causeFit(rec, chosen.models, accepted) : null;
  const starter =
    chosen && o?.detection
      ? recommendStarter(
          (models.data ?? []).flatMap((m) => m.artifacts.map((a) => ({ slug: m.slug, displayName: m.displayName, contentHash: a.contentHash, sizeBytes: a.sizeBytes, acceptedSwarms: m.acceptedSwarms }))),
          chosen.slug,
          memoryFacts(o.detection.hardware),
        )
      : null;

  return (
    <div className="mx-auto max-w-[920px] px-6 py-8">
      <h1 className="text-3xl font-bold">Pick a cause</h1>
      <p className="mt-1 text-zinc-600">Choose what your computer's spare time goes to. You can change this at any time.</p>

      <section aria-label="Causes" className="mt-6">
        <Eyebrow>1. Choose a category</Eyebrow>
        <ul className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {categories.map((c) => {
            const has = all.some((s) => s.category === c.key);
            return (
              <li key={c.key}>
                <button
                  type="button"
                  disabled={!has}
                  aria-pressed={category === c.key}
                  onClick={() => (setCategory(c.key), setSwarm(null))}
                  className={`w-full rounded-lg border px-3 py-3 text-left text-sm disabled:opacity-50 ${category === c.key ? 'border-brand bg-teal-50' : 'border-zinc-200 bg-surface hover:border-brand'}`}
                >
                  <span className="block font-semibold">{c.label}</span>
                  <span className="text-xs text-zinc-500">{has ? 'Available' : 'Coming soon'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {featured && !chosen && (
        <div className="mt-6">
          <Eyebrow>2. Featured cause</Eyebrow>
          <SwarmChoice s={featured} onChoose={() => setSwarm(featured.slug)} />
        </div>
      )}

      {chosen && o && (
        <>
          <section aria-label="Your computer" className="mt-6 rounded-xl border border-zinc-200 bg-surface p-5">
            <div className="flex items-center justify-between">
              <Eyebrow>3. Your computer</Eyebrow>
              <Btn variant="quiet" className="px-2 py-1 text-xs" onClick={() => void actions.detect()}>
                Check again
              </Btn>
            </div>
            <p className="mb-3 text-sm">
              Cause: <b>{chosen.name}</b>{' '}
              <button type="button" className="text-xs text-brand hover:underline" onClick={() => setSwarm(null)}>
                Change
              </button>
            </p>
            <HardwareSummary o={o} />
            {fit && (
              <p role="status" aria-label="Fit" className={`mt-3 rounded-lg px-3 py-2 text-sm ${fit.status === 'policy_mismatch' ? 'bg-red-50 text-red-800' : fit.status === 'cpu_only' ? 'bg-amber-50 text-amber-900' : 'bg-teal-50 text-teal-900'}`}>
                {fit.message}
              </p>
            )}
          </section>

          <fieldset className="mt-6 rounded-xl border border-zinc-200 bg-surface p-5" aria-label="Compute mode">
            <legend className="px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">4. How your node runs models</legend>
            <div className="grid gap-2 md:grid-cols-3">
              {(rec?.options ?? []).map((m) => (
                <label key={m.mode} className={`rounded-lg border p-3 text-sm ${!m.available ? 'opacity-60' : effectiveMode === m.mode ? 'border-brand bg-teal-50' : 'border-zinc-200'}`}>
                  <span className="flex items-center gap-2 font-semibold">
                    <input type="radio" name="mode" aria-label={modeLabel[m.mode]} value={m.mode} disabled={!m.available} checked={effectiveMode === m.mode} onChange={() => setMode(m.mode)} />
                    {modeLabel[m.mode]}
                    {rec?.preselect === m.mode && <span className="text-xs font-normal text-brand">Recommended</span>}
                  </span>
                  <span className="mt-1 block text-xs text-zinc-600">{modeBlurb[m.mode]}</span>
                  <span className="mt-1 block text-xs text-zinc-500">{m.reason}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <section aria-label="Before work begins" className="mt-6 rounded-xl border border-zinc-200 bg-surface p-5">
            <Eyebrow>5. Before any work begins</Eyebrow>
            <RunRulesSummary o={o} />
            <p className="mt-3 text-sm">
              <span className="text-zinc-500">Disk budget:</span>{' '}
              {o.models.storage.diskBudgetBytes ? `${Math.round(o.models.storage.diskBudgetBytes / 1024 ** 3)} GB` : 'you set it when you download your first model.'}
            </p>
            {starter && (
              <p className="mt-2 text-sm" data-testid="starter">
                <span className="text-zinc-500">Recommended starter model:</span> <b>{starter.displayName}</b> ({memoryFitLabel[starter.fit.reason].toLowerCase()}).{' '}
                <span className="text-xs text-zinc-500">After you save, download it from Models with one confirmed click.</span>
              </p>
            )}
            <p className="mt-1 text-xs text-zinc-500">Then join your cause from its page: you review its permissions, and it qualifies on your own model.</p>
          </section>

          {error && (
            <p role="alert" className="mt-4 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="mt-6 flex gap-3">
            <Btn
              className="px-5 py-2.5"
              disabled={!effectiveMode || fit?.status === 'policy_mismatch'}
              onClick={async () => {
                const r = await actions.saveSetup({ mode: effectiveMode!, category: chosen.category, swarm: chosen.slug });
                if (!r) return setError('That mode is not available on this computer.');
                go(starter ? { name: 'model', slug: starter.slug } : { name: 'store' });
              }}
            >
              Save and continue
            </Btn>
            <Btn variant="quiet" className="px-5 py-2.5" onClick={() => setSwarm(null)}>
              Pick another cause
            </Btn>
          </div>
        </>
      )}
      {!swarms.isPending && all.length === 0 && <Empty className="mt-6" title="The catalog could not be reached.">Check your connection and try again.</Empty>}
    </div>
  );
}
