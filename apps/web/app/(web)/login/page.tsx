import { getDb, accounts } from '@swarm-explorer/db';
import { asc } from 'drizzle-orm';
import { devSignInEnabled, safeNext } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in' };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Login({ searchParams }: { searchParams: SP }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw);
  const dev = devSignInEnabled();
  const people = dev ? await (await getDb()).select({ handle: accounts.handle, displayName: accounts.displayName }).from(accounts).orderBy(asc(accounts.handle)) : [];
  // The example user that matches the client mockups goes first.
  people.sort((a, b) => Number(b.handle === 'demo') - Number(a.handle === 'demo'));

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Sign in to Henge web</h1>
      <p className="mt-3 text-ink-2">
        Signing in here connects the Henge desktop app to your account. Joining swarms, running your node and your Wallet live in the client.
      </p>
      {dev ? (
        <section aria-labelledby="dev-sign-in" className="mt-8 rounded-card border border-line p-5">
          <h2 id="dev-sign-in" className="font-semibold text-ink">Development sign in</h2>
          <p className="mt-1 text-sm text-ink-2">
            GitHub, Google, X, email and passkey sign in are not connected in this build. Pick an example user to continue.
          </p>
          <ul className="mt-4 space-y-2">
            {people.map((u) => (
              <li key={u.handle}>
                <form method="post" action="/v1/dev/sign-in">
                  <input type="hidden" name="handle" value={u.handle} />
                  <input type="hidden" name="next" value={next} />
                  <button
                    type="submit"
                    className="flex min-h-11 w-full items-center justify-between rounded-btn border border-line px-4 text-left hover:border-brand"
                  >
                    <span className="font-medium text-ink">{u.displayName}</span>
                    <span className="text-sm text-ink-muted">@{u.handle}</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p role="status" className="mt-8 rounded-card border border-dashed border-zinc-300 p-5 text-ink-2">
          Sign in providers are not configured in this build yet.
        </p>
      )}
    </div>
  );
}
