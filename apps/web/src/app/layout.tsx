import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Frontly',
  description: 'AI рецепционер за мали бизниси',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="mk">
      <body className="min-h-full bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
