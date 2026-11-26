import { listModels } from '@swarm-explorer/db';
import { toModel } from '@/lib/api';
import { formatBytes } from '@/lib/view';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Models' };

/** Model facts (SPEC 4.1). Downloads and fit checks happen in the desktop client. */
export default async function Models() {
  const items = (await listModels()).map(toModel);
  return (
    <div className="mx-auto max-w-[1080px] px-4 py-12 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-4xl font-bold tracking-tight text-ink">Models</h1>
        <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-600">Example data</span>
      </div>
      <p className="mt-2 max-w-2xl text-zinc-700">Local models reviewed for the catalog. Henge checks each download against its published hash before use.</p>
      <ul className="mt-8 space-y-4">
        {items.map((m) => (
          <li key={m.slug} className="rounded-card border border-zinc-200 bg-white p-5">
            <h2 className="text-lg font-bold text-ink">{m.displayName}</h2>
            <p className="text-sm text-zinc-500">{`${m.family} family, class ${m.modelClass}, license ${m.licenseId}, from ${m.source === 'ollama' ? 'Ollama' : 'Hugging Face'}`}</p>
            {m.artifacts.map((a) => (
              <p key={a.contentHash} className="mt-2 text-sm text-ink">
                {`${a.versionLabel}: ${formatBytes(a.sizeBytes)}${a.quantization ? `, ${a.quantization}` : ''}, ${a.contextLength.toLocaleString('en-US')} token context`}
              </p>
            ))}
            <p className="mt-2 text-sm text-zinc-600">{m.acceptedSwarms.length ? `Accepted by ${m.acceptedSwarms.join(', ')}` : 'No listed swarm accepts this model yet'}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
