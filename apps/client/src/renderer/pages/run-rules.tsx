import { enforcementLabel, type RunRules } from '@swarm-explorer/node-core';
import { useState } from 'react';
import type { NodeOverview } from '../../shared/node';
import { useNodeActions } from '../api';
import { Btn } from '../ui/bits';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Run rules editor (SPEC 7.2). Each rule says how this computer enforces it, so a rule that cannot
 * be measured here is never presented as guaranteed.
 */
export function RunRulesEditor({ o }: { o: NodeOverview }) {
  const actions = useNodeActions();
  const [r, setR] = useState<RunRules>(o.rules);
  const [msg, setMsg] = useState<string | null>(null);
  const s = o.support;
  const win = r.when.kind === 'schedule' ? r.when.windows[0]! : { days: [1, 2, 3, 4, 5], start: '22:00', end: '07:00' };
  const dirty = JSON.stringify(r) !== JSON.stringify(o.rules);
  const save = async () => {
    const next = await actions.setRunRules(r);
    setMsg(next ? 'Run rules saved.' : 'Those rules were refused.');
  };
  const tag = (e: keyof typeof enforcementLabel) => <span className="ml-2 text-xs text-zinc-500">{enforcementLabel[e]}</span>;
  return (
    <form
      aria-label="Edit run rules"
      className="mt-4 space-y-3 rounded-lg border border-zinc-200 p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="font-semibold">Edit run rules</h3>
      <fieldset>
        <legend className="text-zinc-500">When</legend>
        <label className="mr-4">
          <input type="radio" name="when" checked={r.when.kind === 'always'} onChange={() => setR({ ...r, when: { kind: 'always' } })} /> Always
        </label>
        <label className="mr-4">
          <input type="radio" name="when" checked={r.when.kind === 'idle'} onChange={() => setR({ ...r, when: { kind: 'idle', idleMinutes: 5 } })} /> Only when idle
          {tag(s.idle)}
        </label>
        <label>
          <input type="radio" name="when" checked={r.when.kind === 'schedule'} onChange={() => setR({ ...r, when: { kind: 'schedule', windows: [win] } })} /> On a schedule
          {tag(s.schedule)}
        </label>
        {r.when.kind === 'idle' && (
          <label className="mt-2 block">
            Idle for{' '}
            <input
              type="number"
              aria-label="Idle minutes"
              min={1}
              max={240}
              value={r.when.idleMinutes}
              onChange={(e) => setR({ ...r, when: { kind: 'idle', idleMinutes: Math.max(1, Math.min(240, Math.round(Number(e.target.value) || 1))) } })}
              className="w-16 rounded border border-zinc-300 bg-zinc-50 px-2 py-0.5"
            />{' '}
            minutes without keyboard or mouse input
          </label>
        )}
        {r.when.kind === 'schedule' && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {DAYS.map((d, i) => (
              <label key={d}>
                <input
                  type="checkbox"
                  checked={win.days.includes(i)}
                  onChange={(e) => {
                    const days = e.target.checked ? [...win.days, i].sort() : win.days.filter((x) => x !== i);
                    if (days.length) setR({ ...r, when: { kind: 'schedule', windows: [{ ...win, days }] } });
                  }}
                />{' '}
                {d}
              </label>
            ))}
            <input type="time" aria-label="From" value={win.start} onChange={(e) => setR({ ...r, when: { kind: 'schedule', windows: [{ ...win, start: e.target.value }] } })} className="rounded border border-zinc-300 bg-zinc-50 px-1" />
            to
            <input type="time" aria-label="Until" value={win.end} onChange={(e) => setR({ ...r, when: { kind: 'schedule', windows: [{ ...win, end: e.target.value }] } })} className="rounded border border-zinc-300 bg-zinc-50 px-1" />
          </div>
        )}
      </fieldset>
      <label className="block">
        <input type="checkbox" checked={r.power === 'plugged_in'} onChange={(e) => setR({ ...r, power: e.target.checked ? 'plugged_in' : 'any' })} /> Only when plugged in
        {tag(s.power)}
      </label>
      <label className="block">
        <input type="checkbox" checked={r.network === 'not_metered'} onChange={(e) => setR({ ...r, network: e.target.checked ? 'not_metered' : 'any' })} /> Not on metered connections
        {tag(s.meteredNetwork)}
      </label>
      <label className="block">
        New tasks wait while CPU load is above{' '}
        <input
          type="number"
          aria-label="Maximum load percent"
          min={5}
          max={100}
          value={r.maxLoadPct}
          onChange={(e) => setR({ ...r, maxLoadPct: Math.max(5, Math.min(100, Math.round(Number(e.target.value) || 5))) })}
          className="w-16 rounded border border-zinc-300 bg-zinc-50 px-2 py-0.5"
        />
        %{tag(s.cpuLoad)}
      </label>
      <div className="flex items-center gap-3">
        <Btn type="submit" className="px-3 py-1.5 text-sm" disabled={!dirty}>
          Save run rules
        </Btn>
        {msg && <span role="status">{msg}</span>}
      </div>
    </form>
  );
}
