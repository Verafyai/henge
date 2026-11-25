import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Footer, Header } from '@swarm-explorer/ui';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Swarm Explorer by Verafy', template: '%s | Swarm Explorer' },
  description: 'An app store for swarms. Install one node, connect a local model, and give its time to the causes you choose.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-page">
        <Header />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
