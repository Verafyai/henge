import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Henge by Verafy', template: '%s | Henge' },
  description: 'A Henge is a swarm you can join, like a social network for your agents.',
};

/**
 * Root layout: fonts only. The henge.verafy.ai pages (`app/(henge)`, dark) and the Henge web
 * store, sign-in and models pages (`app/(web)`, light, with the shared Header and Footer)
 * each bring their own chrome.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-page">{children}</body>
    </html>
  );
}
