'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LANGS, type Lang } from '../../lib/lang';
import { switchLanguage } from '../lang-action';

/**
 * The only client components in the dashboard, and both for the same reason:
 * they need to know something the server does not — which page is open, and
 * which button the owner just pressed.
 */

const ITEMS: { href: string; label: Record<Lang, string> }[] = [
  { href: '/dashboard', label: { mk: 'Денес', sq: 'Sot', en: 'Today' } },
  {
    href: '/dashboard/conversations',
    label: { mk: 'Разговори', sq: 'Bisedat', en: 'Conversations' },
  },
  { href: '/dashboard/calendar', label: { mk: 'Календар', sq: 'Kalendari', en: 'Calendar' } },
  { href: '/dashboard/settings', label: { mk: 'Поставки', sq: 'Cilësimet', en: 'Settings' } },
];

export function Nav({ lang }: { lang: Lang }) {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {ITEMS.map((item) => {
        // "/" must not light up for every route, and a sub-page of
        // /conversations should still show its section as current.
        const current =
          item.href === '/dashboard' ? pathname === '/dashboard' : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} {...(current ? { 'aria-current': 'page' } : {})}>
            {item.label[lang]}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Each language named in its own script, not in the reader's.
 *
 * "МК" in Cyrillic, "SQ" in Latin: someone looking for Albanian is scanning
 * for a Latin word, and rendering every option in one alphabet makes the
 * toggle a puzzle for exactly the person it is there for.
 */
const LABELS: Record<Lang, string> = { mk: 'МК', sq: 'SQ', en: 'EN' };

export function LanguageToggle({ lang }: { lang: Lang }) {
  return (
    <div className="lang" role="group" aria-label="Language">
      {LANGS.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={lang === option}
          onClick={() => void switchLanguage(option)}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
