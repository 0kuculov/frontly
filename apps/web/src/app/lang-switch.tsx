'use client';

import { LANGS, type Lang } from '../lib/lang';
import { switchLanguage } from './lang-action';

/**
 * The language switch on the landing page.
 *
 * Each option is written in its own script — "МК" in Cyrillic, "SQ" and "EN"
 * in Latin — for the same reason as the dashboard's: somebody looking for
 * Albanian is scanning for a Latin word, and rendering all three in one
 * alphabet turns the control into a puzzle for exactly the person it exists
 * for.
 *
 * A client component only because it needs to call the action on click. The
 * language itself comes from the server, so there is no flash of the wrong
 * one and no state to keep in sync.
 */

const LABELS: Record<Lang, string> = { mk: 'МК', sq: 'SQ', en: 'EN' };
const NAMES: Record<Lang, string> = { mk: 'Македонски', sq: 'Shqip', en: 'English' };

export function LangSwitch({ lang }: { lang: Lang }) {
  return (
    <div className="lp-lang" role="group" aria-label="Language">
      {LANGS.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          title={NAMES[option]}
          aria-pressed={lang === option}
          onClick={() => void switchLanguage(option)}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
