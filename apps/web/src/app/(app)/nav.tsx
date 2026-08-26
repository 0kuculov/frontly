'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Lang } from '../../lib/session';
import { switchLanguage } from './actions';

/**
 * The only client components in the dashboard, and both for the same reason:
 * they need to know something the server does not — which page is open, and
 * which button the owner just pressed.
 */

const ITEMS = [
  { href: '/', mk: 'Денес', en: 'Today' },
  { href: '/conversations', mk: 'Разговори', en: 'Conversations' },
  { href: '/calendar', mk: 'Календар', en: 'Calendar' },
  { href: '/settings', mk: 'Поставки', en: 'Settings' },
] as const;

export function Nav({ lang }: { lang: Lang }) {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {ITEMS.map((item) => {
        // "/" must not light up for every route, and a sub-page of
        // /conversations should still show its section as current.
        const current =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} {...(current ? { 'aria-current': 'page' } : {})}>
            {item[lang]}
          </Link>
        );
      })}
    </nav>
  );
}

export function LanguageToggle({ lang }: { lang: Lang }) {
  return (
    <div className="lang" role="group" aria-label="Language">
      {(['mk', 'en'] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={lang === option}
          onClick={() => void switchLanguage(option)}
        >
          {option === 'mk' ? 'МК' : 'EN'}
        </button>
      ))}
    </div>
  );
}
