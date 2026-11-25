import { authorizeQuerySchema } from '@swarm-explorer/api-client';
import { redirect } from 'next/navigation';
import { findClient, redirectAllowed } from '@/lib/auth/oauth';
import { sessionUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Connect the desktop client', robots: { index: false } };

type SP = Promise<Record<string, string | string[] | undefined>>;

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-bold text-ink">This sign in link is not valid</h1>
      <p className="mt-3 text-ink-2">{children}</p>
    </div>
  );
}

/** Consent step for the desktop client's OAuth request (SPEC 4.4). */
export default async function Authorize({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = authorizeQuerySchema.safeParse(flat);
  if (!parsed.success) return <Problem>Start sign in again from the Swarm Explorer client.</Problem>;
  const q = parsed.data;
  const client = await findClient(q.client_id);
  if (!client || !redirectAllowed(client.redirectUris, q.redirect_uri)) return <Problem>The app that sent you here is not registered.</Problem>;

  const user = await sessionUser();
  if (!user) {
    const here = `/authorize?${new URLSearchParams(q as Record<string, string>).toString()}`;
    redirect(`/login?next=${encodeURIComponent(here)}`);
  }

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-3xl font-bold tracking-tight text-ink">Connect the desktop client</h1>
      <p className="mt-3 text-ink-2">
        <b className="text-ink">{client.name}</b> wants to sign in as <b className="text-ink">{user.displayName}</b> (@{user.handle}). It can see your account
        and act for you in the client. Every pledge, vote and post still asks you to confirm in the client.
      </p>
      <form method="post" action="/v1/oauth/authorize" className="mt-8 flex gap-3">
        {Object.entries(q).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <button name="decision" value="allow" type="submit" className="inline-flex min-h-11 flex-1 items-center justify-center rounded-btn bg-brand font-semibold text-white hover:bg-brand-hover">
          Continue to the client
        </button>
        <button name="decision" value="deny" type="submit" className="inline-flex min-h-11 items-center justify-center rounded-btn border border-line px-5 font-semibold text-ink hover:border-brand">
          Cancel
        </button>
      </form>
      <p className="mt-4 text-xs text-ink-muted">Not you? Close this tab. Nothing happens until you continue.</p>
    </div>
  );
}
