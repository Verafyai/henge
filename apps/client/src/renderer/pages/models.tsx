import type { CatalogModel } from '@swarm-explorer/api-client';
import { estimateFit, fitLabel, fitReasonText, memoryFacts, type FitReason, type FitStatus } from '@swarm-explorer/node-core';
import { Chip } from '@swarm-explorer/ui';
import { useState } from 'react';
import type { InstalledModel, ModelActionResult, NodeOverview } from '../../shared/node';
import { useModels, useNode } from '../api';
import { Btn, Empty, Eyebrow } from '../ui/bits';

const GB = 1024 ** 3;
const gb = (n: number) => `${Math.round((n / GB) * 10) / 10} GB`;
const fitTone: Record<FitStatus, 'approved' | 'pending' | 'rejected' | 'info'> = { runs_well: 'approved', runs_slowly: 'pending', will_not_fit: 'rejected', unknown: 'info' };
const runtimeOf = (a: CatalogModel['artifacts'][number]) => (a.runtimeFormats.includes('ollama') ? 'Ollama' : 'llama.cpp (GGUF)');

function FitChip({ status, basis }: { status: FitStatus; basis: 'estimate' | 'benchmark' }) {
  return (
    <Chip tone={fitTone[status]}>
      {fitLabel[status]}
      {basis === 'estimate' && status !== 'will_not_fit' ? ' (estimate)' : ''}
    </Chip>
  );
}

function Result({ r }: { r: ModelActionResult | null }) {
  if (!r || r.ok) return null;
  return (
    <p role="alert" className="mt-2 text-sm text-red-700">
      {r.message}
    </p>
  );
}

/** One confirmed click (SPEC 5.1 step 5): size, license, disk budget and fit are shown before anything downloads. */
function DownloadDialog({ m, a, o, onClose }: { m: CatalogModel; a: CatalogModel['artifacts'][number]; o: NodeOverview; onClose: () => void }) {
  const [license, setLicense] = useState(o.models.acceptedLicenses.includes(a.contentHash));
  const needsBudget = o.models.storage.diskBudgetBytes === null;
  const free = o.detection?.hardware.freeDiskBytes ?? null;
  const [budgetGb, setBudgetGb] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ModelActionResult | null>(null);
  const fit = o.detection ? estimateFit(a.sizeBytes, memoryFacts(o.detection.hardware)) : null;
  const budgetBytes = Math.round(Number(budgetGb) * GB);
  const budgetOk = !needsBudget || (Number.isFinite(budgetBytes) && budgetBytes > 0);
  const byHash = new Map(o.models.installed.map((x) => [x.contentHash, x]));

  return (
    <div role="dialog" aria-modal="true" aria-label={`Download ${m.displayName}`} className="mt-3 rounded-lg border border-brand bg-teal-50/40 p-4 text-sm">
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1">
        <dt className="text-zinc-500">Download size</dt>
        <dd>{gb(a.sizeBytes)}</dd>
        <dt className="text-zinc-500">Runtime</dt>
        <dd>{runtimeOf(a)}</dd>
        <dt className="text-zinc-500">Fit</dt>
        <dd>{fit ? `${fitLabel[fit.status]}. ${fitReasonText[fit.reason]}` : 'Unknown'}</dd>
        <dt className="text-zinc-500">Disk budget</dt>
        <dd>{needsBudget ? 'Not set yet' : `${gb(o.models.usedBytes)} of ${gb(o.models.storage.diskBudgetBytes!)} used`}</dd>
        <dt className="text-zinc-500">Pinned hash</dt>
        <dd className="font-mono text-xs">{a.contentHash.slice(0, 19)}</dd>
      </dl>
      {needsBudget && (
        <label className="mt-3 block">
          <span className="block font-medium">Disk budget for models (GB)</span>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={budgetGb}
            onChange={(e) => setBudgetGb(e.target.value)}
            className="mt-1 w-32 rounded border border-zinc-300 px-2 py-1"
            aria-describedby="budget-help"
          />
          <span id="budget-help" className="mt-1 block text-xs text-zinc-500">
            {free !== null ? `${gb(free)} free on this disk. ` : ''}When the budget is full, least-used models are suggested for removal; your active model never is.
          </span>
        </label>
      )}
      <label className="mt-3 flex items-start gap-2">
        <input type="checkbox" checked={license} onChange={(e) => setLicense(e.target.checked)} className="mt-1" />
        <span>
          I accept the <b>{m.licenseId}</b> license for {m.displayName} {a.versionLabel}.
        </span>
      </label>
      <p className="mt-2 text-xs text-zinc-500">The download is checked against the pinned hash. A mismatch is blocked and the file is removed.</p>
      <Result r={result} />
      {result && !result.ok && result.suggestions && result.suggestions.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold">Suggested to remove (least used):</p>
          <ul className="mt-1 space-y-1" aria-label="Suggested removals">
            {result.suggestions.map((h) => (
              <li key={h} className="flex items-center gap-2">
                <span>{byHash.get(h)?.displayName ?? h.slice(0, 19)}</span>
                <Btn variant="quiet" className="px-2 py-0.5 text-xs" onClick={async () => setResult(await window.swarm.models.remove(h))}>
                  Remove
                </Btn>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Btn
          className="px-4 py-2"
          disabled={!license || !budgetOk || busy}
          onClick={async () => {
            setBusy(true);
            const r = await window.swarm.models.install({ slug: m.slug, contentHash: a.contentHash, acceptLicense: true, ...(needsBudget ? { diskBudgetBytes: budgetBytes } : {}) });
            setBusy(false);
            setResult(r);
            if (r.ok) onClose();
          }}
        >
          Download and verify
        </Btn>
        <Btn variant="quiet" className="px-4 py-2" onClick={onClose}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}

function InstalledActions({ i, o }: { i: InstalledModel; o: NodeOverview }) {
  const [result, setResult] = useState<ModelActionResult | null>(null);
  const active = o.models.storage.activeModel === i.contentHash;
  const busy = o.models.job !== null;
  return (
    <div className="mt-3">
      <p className="text-sm" data-testid="benchmark">
        {i.benchmarkTps !== null ? `Benchmark: ${i.benchmarkTps} tokens per second.` : (i.benchmarkDetail ?? 'Not benchmarked yet.')}{' '}
        <span className="text-xs text-zinc-500">{fitReasonText[i.fit.reason as FitReason] ?? ''}</span>
        {i.benchmarkSharedAt && <span className="block text-xs text-zinc-500">Benchmark shared with your node record.</span>}
      </p>
      {!i.managed && <p className="mt-1 text-xs text-zinc-500">Already in your Ollama. Swarm Explorer uses it but never removes it.</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {active ? (
          <Chip tone="approved">Active model</Chip>
        ) : (
          <Btn variant="quiet" className="px-3 py-1 text-xs" onClick={async () => setResult(await window.swarm.models.setActive(i.contentHash))}>
            Make active
          </Btn>
        )}
        <Btn variant="quiet" className="px-3 py-1 text-xs" disabled={busy} onClick={async () => setResult(await window.swarm.models.benchmark(i.contentHash))}>
          Benchmark again
        </Btn>
        {i.managed && (
          <Btn
            variant="quiet"
            className="px-3 py-1 text-xs"
            disabled={active || busy}
            title={active ? 'Your active model is never removed. Make another model active first.' : undefined}
            onClick={async () => setResult(await window.swarm.models.remove(i.contentHash))}
          >
            {active ? 'Remove (in use)' : 'Remove'}
          </Btn>
        )}
      </div>
      <Result r={result} />
    </div>
  );
}

/** Model catalog (SPEC 4.2, 5.4): source, hash, size, context, quantization, license, accepted swarms, fit. */
export function ModelsPage({ highlight }: { highlight?: string }) {
  const q = useModels();
  const node = useNode();
  const o = node.data;
  const [open, setOpen] = useState<string | null>(null);
  const facts = o?.detection ? memoryFacts(o.detection.hardware) : null;
  const installed = new Map((o?.models.installed ?? []).map((i) => [i.contentHash, i]));
  const blocked = new Map((o?.models.blocked ?? []).map((b) => [b.contentHash, b]));
  const job = o?.models.job ?? null;
  const st = o?.models.storage;

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Models</h1>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
      </div>
      <p className="mt-1 text-sm text-zinc-600" data-testid="storage">
        {st?.diskBudgetBytes ? `Disk budget: ${gb(o!.models.usedBytes)} of ${gb(st.diskBudgetBytes)} used.` : 'Disk budget: set when you download your first model.'}
      </p>
      {job && (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 text-sm" role="status" aria-label="Model job">
          {job.phase === 'benchmarking' ? `Benchmarking ${job.slug}` : `Downloading ${job.slug}`}
          {job.phase === 'downloading' && job.total ? (
            <progress className="ml-3 align-middle" max={job.total} value={job.completed} aria-label="Download progress" />
          ) : null}
        </div>
      )}
      {q.isError && <Empty className="mt-4" title="The catalog could not be reached." />}
      <ul className="mt-4 space-y-3">
        {(q.data ?? []).map((m) =>
          m.artifacts.map((a) => {
            const i = installed.get(a.contentHash);
            const b = blocked.get(a.contentHash);
            const est = facts ? estimateFit(a.sizeBytes, facts) : null;
            const fit = i ? i.fit : est ? { status: est.status, basis: est.basis } : null;
            const key = `${m.slug}:${a.contentHash}`;
            return (
              <li
                key={key}
                aria-label={m.displayName}
                className={`rounded-xl border bg-white p-4 ${highlight && (m.slug === highlight || m.modelClass === highlight) ? 'border-brand' : 'border-zinc-200'}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-ink">{m.displayName}</p>
                    <p className="text-xs text-zinc-500">{`${m.source === 'ollama' ? 'Ollama library' : 'Hugging Face GGUF'} · ${a.versionLabel} · ${runtimeOf(a)}`}</p>
                  </div>
                  <span className="flex gap-1.5">
                    {fit && <FitChip status={fit.status as FitStatus} basis={fit.basis as 'estimate' | 'benchmark'} />}
                    {i && <Chip tone="approved">Installed</Chip>}
                    {b && <Chip tone="rejected">Blocked</Chip>}
                  </span>
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
                  <div><dt className="text-zinc-500">Size on disk</dt><dd>{gb(a.sizeBytes)}</dd></div>
                  <div><dt className="text-zinc-500">Context</dt><dd>{`${a.contextLength.toLocaleString('en-US')} tokens`}</dd></div>
                  <div><dt className="text-zinc-500">Quantization</dt><dd>{a.quantization}</dd></div>
                  <div><dt className="text-zinc-500">License</dt><dd>{m.licenseId}</dd></div>
                  <div className="col-span-2"><dt className="text-zinc-500">Accepted by</dt><dd>{m.acceptedSwarms.length ? m.acceptedSwarms.join(', ') : 'No listed swarm yet'}</dd></div>
                  <div className="col-span-2"><dt className="text-zinc-500">Content hash</dt><dd className="font-mono">{a.contentHash.slice(0, 19)}</dd></div>
                </dl>
                {b && (
                  <p role="alert" className="mt-2 rounded bg-red-50 px-2 py-1 text-sm text-red-800">
                    {`Blocked: ${b.reason === 'tag_drift' ? 'your Ollama tag has different contents than the pinned version' : 'hash mismatch'}. ${b.detail}`}
                  </p>
                )}
                {i && o ? (
                  <InstalledActions i={i} o={o} />
                ) : o && open === key ? (
                  <DownloadDialog m={m} a={a} o={o} onClose={() => setOpen(null)} />
                ) : (
                  <Btn className="mt-3 px-3 py-1.5 text-sm" disabled={!o || job !== null || est?.status === 'will_not_fit'} onClick={() => setOpen(key)}>
                    {est?.status === 'will_not_fit' ? 'Will not fit' : b ? 'Try again' : 'Download'}
                  </Btn>
                )}
              </li>
            );
          }),
        )}
      </ul>
      {o && !o.models.installed.length && !q.isPending && (
        <p className="mt-6 text-xs text-zinc-500">
          <Eyebrow>Note</Eyebrow>Fit before download is estimated from memory size only. After download, a short benchmark is recorded.
        </p>
      )}
    </div>
  );
}
