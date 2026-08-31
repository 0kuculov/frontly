import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLang, getSessionToken } from '../lib/session';
import type { Lang } from '../lib/lang';
import { LANDING } from './landing-copy';
import { LangSwitch } from './lang-switch';
import { Logo, Wordmark } from './logo';
import './landing.css';

/**
 * The way in for someone who has never heard of Frontly.
 *
 * The audience is two people at once: a clinic owner deciding whether a
 * machine can be trusted with their phone, and a judge deciding whether this
 * is a product or a demo. Both are answered the same way, by letting them
 * ring it. The primary call to action is the actual phone number, because a
 * phone product that asks you to read about it instead of calling it has
 * already lost the argument.
 *
 * In three languages, from the same cookie the dashboard uses, because the
 * judge who wants English and the owner from Tetovo who wants Albanian are
 * both on this page before they are anywhere else.
 *
 * No signup form. See the note on the sign-in card.
 */

export const dynamic = 'force-dynamic';

const PHONE_DISPLAY = '+1 619 349 7599';
const PHONE_HREF = 'tel:+16193497599';

/** Who the other voice on the transcript is, in the reader's language. */
const SPEAKER: Record<Lang, string> = { mk: 'Пациент', sq: 'Klienti', en: 'Caller' };

/**
 * A real exchange, taken verbatim from a booking that went through the live
 * model, digits and all.
 *
 * Deliberately NOT a drawn phone with a fake status bar and a fake battery.
 * A simulated screenshot built out of divs is the oldest tell there is, and
 * this is the actual product output, which is more convincing than a picture
 * of it would be.
 *
 * Never translated, in any language. It is what was said; a "real call" that
 * changes language per visitor is a lie about the one thing on this page that
 * proves the product works. The label above it says which language it is in.
 */
const EXCHANGE = [
  { who: 'caller', text: 'Добар ден, сакам да закажам стоматолошки преглед.' },
  { who: 'agent', text: 'Добар ден. За кој датум и приближно време би сакале?' },
  { who: 'caller', text: 'Утре наутро, ако може.' },
  {
    who: 'agent',
    text: 'Имаме слободно утре во девет и половина наутро, кај доктор Ана Смилевска.',
  },
  { who: 'caller', text: 'Одлично, тоа ми одговара.' },
  {
    who: 'agent',
    text: 'Ве запишав како Марко Петровски, на бројот нула седум нула, еден два три, четири пет шест. Точно?',
    tool: 'confirm_details',
  },
  { who: 'caller', text: 'Да, точно е.' },
  {
    who: 'agent',
    text: 'Готово, терминот е закажан. Ќе добиете потврда со порака.',
    tool: 'book_appointment',
  },
] as const;

export default async function LandingPage() {
  // Someone who is already signed in wants the dashboard, not the pitch.
  if (await getSessionToken()) redirect('/dashboard');

  const lang = await getLang();
  const c = LANDING[lang];

  return (
    <div className="landing" lang={lang}>
      <header className="lp-nav">
        <Link href="/" className="lp-brand" aria-label="Frontly">
          <Wordmark size={24} />
        </Link>
        <nav>
          <LangSwitch lang={lang} />
          <a href={PHONE_HREF} className="lp-nav-phone" aria-label={c.navPhone}>
            {PHONE_DISPLAY}
          </a>
          <Link href="/login" className="lp-nav-signin">
            {c.navSignIn}
          </Link>
        </nav>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow">{c.eyebrow}</p>
            <h1>
              {c.headline[0]}
              <br />
              {c.headline[1]}
            </h1>
            <p className="lp-lede">{c.lede}</p>
            {/*
              The number IS the hero, on its own ruled row.
              The whole product is a phone line that answers, so the thing to
              put at display size is the thing a visitor can do right now.
            */}
            <a href={PHONE_HREF} className="lp-dial">
              <span className="lp-dial-number">{PHONE_DISPLAY}</span>
              <span className="lp-dial-note">{c.dialNote}</span>
            </a>
            <div className="lp-cta">
              <a href={PHONE_HREF} className="lp-btn lp-btn-primary">
                {c.cta}
              </a>
            </div>
          </div>

          <div className="lp-exchange" aria-label={c.exchangeLabel}>
            <div className="lp-exchange-head">
              <span className="lp-live" aria-hidden />
              {c.exchangeLabel}
            </div>
            {/* `lang="mk"` so a screen reader does not read Cyrillic with an
                English voice when the page is in English. */}
            <ol lang="mk">
              {EXCHANGE.map((line, index) => (
                <li
                  key={index}
                  data-who={line.who}
                  data-speaker={line.who === 'agent' ? 'Frontly' : SPEAKER[lang]}
                >
                  <span className="lp-bubble">{line.text}</span>
                  {'tool' in line && line.tool ? (
                    <span className="lp-tool">{line.tool}</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/*
          One band, three verbs. Not three equal cards: that layout is the
          default answer to "we have three things" and says nothing. Reading
          left to right IS the sequence, so no numbering is needed.
        */}
        <section className="lp-band">
          <h2>{c.bandTitle}</h2>
          <div className="lp-band-grid">
            {c.band.map(([strong, rest], index) => (
              <p key={index}>
                <strong>{strong}</strong>
                {rest}
              </p>
            ))}
          </div>
        </section>

        <section className="lp-facts">
          <dl>
            {c.facts.map(([label, value, note]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
                <p>{note}</p>
              </div>
            ))}
          </dl>
        </section>

        <section className="lp-signin">
          <div className="lp-signin-card">
            <Logo size={30} />
            <h2>{c.signInTitle}</h2>
            <p>{c.signInBody}</p>
            <Link href="/login" className="lp-btn lp-btn-primary">
              {c.signInCta}
            </Link>
            {/*
              No public sign-up, and the reason is specific rather than
              squeamish: inbound calls are routed to the only business when
              exactly one exists, so creating a second one from a web form
              would silently break the phone line this page invites people to
              ring. New clinics are set up by hand until numbers are assigned
              per business.
            */}
            <p className="lp-fine">{c.newClinic(PHONE_DISPLAY)}</p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <Wordmark size={20} />
        <p>{c.footer}</p>
      </footer>
    </div>
  );
}
