import { cn } from './cn';
import { Logo } from './logo';

export type HeaderProps = {
  active?: 'store' | 'models' | 'download' | null;
  signedIn?: boolean;
  searchAction?: string;
};

/** Website navigation is browse-only (SPEC 4.1): normal product actions happen in the desktop client. */
const nav = [
  { key: 'store', label: 'Swarms', href: '/' },
  { key: 'models', label: 'Models', href: '/models' },
  { key: 'download', label: 'Download', href: '/download' },
] as const;

export function Header({ active = 'store', signedIn = false, searchAction = '/' }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-accent/40 bg-white/90 backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:rounded-btn focus:bg-brand focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <div className="mx-auto flex h-16 max-w-[1280px] items-center gap-6 px-4 sm:px-8">
        <Logo />
        <nav aria-label="Main" className="hidden whitespace-nowrap lg:block">
          <ul className="flex items-center gap-5">
            {nav.map((n) => (
              <li key={n.key}>
                <a
                  href={n.href}
                  aria-current={active === n.key ? 'page' : undefined}
                  className={cn('inline-flex min-h-10 items-center text-sm hover:text-brand', active === n.key ? 'font-semibold text-brand' : 'text-zinc-700')}
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex-1" />
        <form action={searchAction} role="search" className="relative hidden w-[230px] shrink-0 md:block">
          <label htmlFor="site-search" className="sr-only">Search swarms</label>
          <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400">
            <path fill="currentColor" d="M8.5 3a5.5 5.5 0 0 1 4.38 8.83l3.65 3.64-1.06 1.06-3.64-3.65A5.5 5.5 0 1 1 8.5 3Zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          </svg>
          <input
            id="site-search"
            name="q"
            type="search"
            placeholder="Search swarms"
            className="h-10 w-full rounded-lg border border-zinc-300 bg-zinc-50 pl-9 pr-3 text-sm placeholder:text-zinc-500 focus:border-brand focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
        </form>
        {!signedIn && (
          <a href="/login" className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 text-sm font-semibold text-zinc-700 hover:bg-fill hover:text-ink">
            Sign in
          </a>
        )}
        <a href="/download" className="inline-flex min-h-10 shrink-0 items-center whitespace-nowrap rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover">
          Get Swarm Explorer
        </a>
      </div>
    </header>
  );
}
