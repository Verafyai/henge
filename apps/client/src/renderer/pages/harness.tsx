import { useQuery } from '@tanstack/react-query';
import { Chip } from '@swarm-explorer/ui';
import { getClient, useSwarms } from '../api';
import { Empty } from '../ui/bits';

/** Harness detail (SPEC 4.2): publisher, signature, version and hash, output schema, review and revocation badges. */
export function HarnessPage({ name }: { name: string }) {
  const swarms = useSwarms();
  const version = swarms.data?.find((s) => s.harness.name === name)?.harness.version;
  const q = useQuery({ queryKey: ['harness', name, version], enabled: Boolean(version), queryFn: async () => (await getClient()).harnessRelease(name, version!) });
  if (swarms.isPending || q.isPending) return <p className="p-6 text-sm text-zinc-500">Loading harness</p>;
  if (!version || q.isError || !q.data)
    return (
      <div className="p-6">
        <Empty title="This harness is not listed.">Only reviewed harnesses used by a listed swarm appear here.</Empty>
      </div>
    );
  const h = q.data;
  const facts: Array<[string, string]> = [
    ['Publisher', h.publisher.badge === 'verified' ? `${h.publisher.name} (verified)` : `${h.publisher.name} (verification pending)`],
    ['Version', h.version],
    ['Runtime', h.runtime === 'wasm' ? 'WebAssembly, in the sandbox' : 'Container (not supported by this version of Henge)'],
    ['Minimum model class', h.minModelClass],
    ['Signed by', h.signingKey ? `${h.signingKey.keyId}${h.signingKey.status === 'revoked' ? ' (revoked)' : ''}` : 'No registered key'],
    ['Bundle hash', h.bundleHash],
    ['Output schema hash', h.outputSchemaHash],
    ['Software bill of materials', h.sbomHash],
  ];
  return (
    <div className="mx-auto max-w-[860px] px-6 py-6">
      <div className="flex gap-2">
        <Chip tone={h.reviewed ? 'approved' : 'pending'}>{h.reviewed ? 'Reviewed' : 'Not reviewed'}</Chip>
        {h.revoked && <Chip tone="rejected">Revoked</Chip>}
      </div>
      <h1 className="mt-3 text-3xl font-bold">{h.name}</h1>
      <dl className="mt-4 space-y-2 rounded-xl border border-zinc-200 bg-white p-4 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <dt className="text-zinc-500">{k}</dt>
            <dd className="break-all text-right font-mono text-[12px] text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-zinc-600">Henge checks this hash and signature on your computer before every run. A bundle that does not match is refused.</p>
    </div>
  );
}
