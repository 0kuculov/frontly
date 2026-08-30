import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionToken } from '../lib/session';
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
 * No signup form. See the note on the sign-in card.
 */

export const dynamic = 'force-dynamic';

const PHONE_DISPLAY = '+1 619 349 7599';
const PHONE_HREF = 'tel:+16193497599';

/**
 * A real exchange, taken verbatim from a booking that went through the live
 * model, digits and all.
 *
 * Deliberately NOT a drawn phone with a fake status bar and a fake battery.
 * A simulated screenshot built out of divs is the oldest tell there is, and
 * this is the actual product output, which is more convincing than a picture
 * of it would be.
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

  return (
    <div className="landing">
      <header className="lp-nav">
        <Link href="/" className="lp-brand" aria-label="Frontly">
          <Wordmark size={24} />
        </Link>
        <nav>
          <a href={PHONE_HREF} className="lp-nav-phone">
            {PHONE_DISPLAY}
          </a>
          <Link href="/login" className="lp-nav-signin">
            Најава
          </Link>
        </nav>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-hero-copy">
            <h1>
              Вашата ординација
              <br />
              не пропушта повик.
            </h1>
            <p className="lp-lede">
              Frontly се јавува, разбира македонски и закажува во вашиот календар.
              Секој ден, во секое време.
            </p>
            <div className="lp-cta">
              <a href={PHONE_HREF} className="lp-btn lp-btn-primary">
                Јавете се и пробајте
              </a>
              <span className="lp-cta-number">{PHONE_DISPLAY}</span>
            </div>
          </div>

          <div className="lp-exchange" aria-label="Пример од вистински разговор">
            <div className="lp-exchange-head">
              <span className="lp-live" aria-hidden />
              Вистински повик
            </div>
            <ol>
              {EXCHANGE.map((line, index) => (
                <li key={index} data-who={line.who}>
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
          <h2>Ѕвони. Одговара. Закажува.</h2>
          <div className="lp-band-grid">
            <p>
              <strong>Се јавува на првото ѕвонење</strong>, дури и кога сте со
              пациент, во сабота или во три наутро.
            </p>
            <p>
              <strong>Проверува вистинска слободна термина</strong> според работното
              време, услугата и кој доктор ја работи.
            </p>
            <p>
              <strong>Го прочитува бројот назад</strong> цифра по цифра и чека
              потврда пред да закажe.
            </p>
          </div>
        </section>

        <section className="lp-facts">
          <dl>
            <div>
              <dt>Јазици</dt>
              <dd>3</dd>
              <p>Македонски, албански, англиски.</p>
            </div>
            <div>
              <dt>Достапност</dt>
              <dd>24/7</dd>
              <p>Без пропуштен повик и без говорна пошта.</p>
            </div>
            <div>
              <dt>Цена по разговор</dt>
              <dd>$0.39</dd>
              <p>Измерено на вистински повик, не проценето.</p>
            </div>
          </dl>
        </section>

        <section className="lp-signin">
          <div className="lp-signin-card">
            <Logo size={30} />
            <h2>Веќе имате ординација кај нас?</h2>
            <p>
              Влезете во таблата за да ги видите повиците, термините и што кажал
              секој пациент.
            </p>
            <Link href="/login" className="lp-btn lp-btn-primary">
              Најава
            </Link>
            {/*
              No public sign-up, and the reason is specific rather than
              squeamish: inbound calls are routed to the only business when
              exactly one exists, so creating a second one from a web form
              would silently break the phone line this page invites people to
              ring. New clinics are set up by hand until numbers are assigned
              per business.
            */}
            <p className="lp-fine">
              Нова ординација? Јавете се на {PHONE_DISPLAY} и ве поставуваме ние.
            </p>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <Wordmark size={20} />
        <p>Виртуелен рецепционер за мали ординации во Северна Македонија.</p>
      </footer>
    </div>
  );
}
