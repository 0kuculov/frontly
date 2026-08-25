import type { Metadata } from 'next';
import { Golos_Text, IBM_Plex_Mono } from 'next/font/google';
import './globals.css';

/**
 * Cyrillic-native typography, because the product is Macedonian.
 *
 * Golos Text was drawn for Cyrillic rather than having it bolted on, which
 * matters when every word on the demo screen is Macedonian and projected at
 * size. Plex Mono carries the data and the tool names — a telex register for
 * the machine's own vocabulary, next to the human sentences.
 */
const golos = Golos_Text({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-golos',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin', 'cyrillic'],
  weight: ['400', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Frontly',
  description: 'AI рецепционер за мали бизниси',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="mk" className={`${golos.variable} ${plexMono.variable}`}>
      <body className="min-h-full bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
