import type { Metadata } from 'next';
import { Footer, Header } from '@swarm-explorer/ui';

export const metadata: Metadata = {
  title: { default: 'Henge web by Verafy', template: '%s | Henge web' },
  description: 'Browse swarms. Install one node, connect a local model, and give its time to the causes you choose.',
};

/** Henge web: the swarm store, swarm pages, models and sign-in (light Verafy theme, shared Header and Footer). */
export default function WebLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main id="main">{children}</main>
      <Footer />
    </>
  );
}
