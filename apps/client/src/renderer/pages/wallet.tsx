import { useWallet } from '../api';
import { ResultsList } from './results';

/**
 * Wallet (SPEC 4.1, 9). Impact from volunteer work always; credits only once the account has work
 * in a funded swarm. Credits are earned, never bought, and cannot be transferred or cashed out.
 */
export function WalletPage() {
  const w = useWallet();
  const d = w.data;
  return (
    <div className="mx-auto max-w-[960px] px-6 py-8">
      <h1 className="text-3xl font-bold">Wallet</h1>
      <p className="mt-2 text-zinc-600">Impact counts verified volunteer work. Credits come only from verified work in funded swarms. Neither can be bought, sent to someone else or cashed out.</p>
      {d === null ? (
        <p className="mt-6 text-sm text-zinc-600">Sign in and connect to see your wallet.</p>
      ) : !d ? null : (
        <div className="mt-6 space-y-4">
          <section aria-label="Impact" className="rounded-xl border border-zinc-200 p-5">
            <h2 className="font-semibold">Impact</h2>
            <dl className="mt-2 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-xs text-zinc-500">Settled</dt>
                <dd className="text-2xl font-semibold" data-testid="impact-settled">
                  {d.impact.settled}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Pending review</dt>
                <dd className="text-2xl font-semibold" data-testid="impact-pending">
                  {d.impact.pending}
                </dd>
              </div>
            </dl>
          </section>
          {d.has_funded_work ? (
            <section aria-label="Credits" className="rounded-xl border border-zinc-200 p-5">
              <h2 className="font-semibold">Credits</h2>
              <dl className="mt-2 grid grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-zinc-500">Settled</dt>
                  <dd className="text-2xl font-semibold">{d.credits.settled}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Pending review</dt>
                  <dd className="text-2xl font-semibold">{d.credits.pending}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-500">Reserved for your running tasks</dt>
                  <dd className="text-2xl font-semibold">{d.credits.reserved}</dd>
                </div>
              </dl>
            </section>
          ) : (
            <p className="text-sm text-zinc-600" data-testid="no-credits">
              Your work so far is in volunteer swarms, so it earns impact, not credits.
            </p>
          )}
          <section aria-label="Results" className="rounded-xl border border-zinc-200 p-5">
            <h2 className="font-semibold">Results</h2>
            <ResultsList label="Wallet results" />
          </section>
        </div>
      )}
    </div>
  );
}
