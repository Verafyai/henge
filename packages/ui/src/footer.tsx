import { VerafyMark } from './logo';

const cols = [
  { title: 'Explore', links: [['Swarms', '/swarms'], ['Models', '/models']] },
  { title: 'Node', links: [['Download', '/download'], ['Sign in', '/login']] },
] as const;

export function Footer() {
  return (
    <footer className="mt-20 border-t border-zinc-200 bg-zinc-50">
      <div className="mx-auto grid max-w-[1280px] gap-8 px-4 py-10 text-sm sm:px-8 md:grid-cols-4">
        <div className="md:col-span-2">
          <VerafyMark className="mb-3 h-4 w-auto text-ink" />
          <p className="max-w-sm text-zinc-600">
            Henge web by Verafy is where you browse swarms. Henge, the desktop app, runs one node on a local model and gives its spare time to the causes you choose.
          </p>
        </div>
        {cols.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <h2 className="mb-2 font-semibold text-ink">{c.title}</h2>
            <ul className="space-y-1 text-zinc-600">
              {c.links.map(([label, href]) => (
                <li key={label}>
                  <a href={href} className="hover:text-brand">{label}</a>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <p className="mx-auto max-w-[1280px] px-4 pb-8 text-xs text-zinc-500 sm:px-8">
        Swarms, models, people and numbers shown are example data. Credits are earned only for verified work in funded swarms, are usable only inside
        the network, and cannot be cashed out or transferred. Volunteer swarms award impact, which is not spendable.
      </p>
    </footer>
  );
}
