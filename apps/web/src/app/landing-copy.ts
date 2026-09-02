import type { Lang } from '../lib/lang';

/**
 * Everything the landing page says, in the three languages the phone answers.
 *
 * Kept out of the page so the page reads as a layout rather than as a wall of
 * strings, and so the three versions sit next to each other where a missing
 * one is obvious. `Record<Lang, LandingCopy>` means adding a language is a
 * compile error until it is finished, not a half-translated page.
 *
 * The Albanian has not been read by a native speaker. Same caveat as the
 * dashboard dictionary and the voice phrasing tables.
 */

export interface LandingCopy {
  /** Mono label over the headline: who this is for. */
  eyebrow: string;
  navSignIn: string;
  /** Two lines, and they are two lines on purpose — see the <br> in the page. */
  headline: [string, string];
  lede: string;
  /** Only rendered when a contact address is configured. See page.tsx. */
  contactCta: string;
  contactFine: string;
  /**
   * The transcript is REAL and it is in Macedonian, so it is never translated
   * — a "verbatim" transcript that changes language per visitor is a lie about
   * the one thing on the page that proves the product works. The label says
   * which language it is in instead.
   */
  exchangeLabel: string;
  bandTitle: string;
  band: [string, string, string][];
  facts: [label: string, value: string, note: string][];
  signInTitle: string;
  signInBody: string;
  signInCta: string;
  footer: string;
}

export const LANDING: Record<Lang, LandingCopy> = {
  mk: {
    eyebrow: 'Ординации · Салони · Автосервиси',
    navSignIn: 'Најава',
    headline: ['Секој пропуштен повик', 'е изгубен термин.'],
    lede: 'Frontly се јавува кога вие не можете, разбира македонски и закажува во вашиот календар. Без говорна пошта и без пропуштени клиенти.',
    contactCta: 'Побарајте демо',
    contactFine: 'Нов бизнис? Пишете ни и ве поставуваме ние.',
    exchangeLabel: 'Вистински повик',
    bandTitle: 'Ѕвони. Одговара. Закажува.',
    band: [
      [
        'Се јавува на првото ѕвонење',
        ', дури и кога сте со клиент, во сабота или во три наутро.',
        '',
      ],
      [
        'Проверува вистински слободни термини',
        ' според работното време, услугата и кој од вработените ја работи.',
        '',
      ],
      ['Го прочитува бројот назад', ' цифра по цифра и чека потврда пред да закажe.', ''],
    ],
    facts: [
      ['Јазици', '3', 'Македонски, албански, англиски.'],
      ['Достапност', '24/7', 'Без пропуштен повик и без говорна пошта.'],
      ['Цена по разговор', '$0.39', 'Измерено на вистински повик, не проценето.'],
    ],
    signInTitle: 'Веќе работите со нас?',
    signInBody:
      'Влезете во таблата за да ги видите повиците, термините и што кажал секој клиент.',
    signInCta: 'Најава',
    footer: 'Виртуелен рецепционер за мали бизниси во Северна Македонија.',
  },

  sq: {
    eyebrow: 'Klinika · Sallone · Autoservise',
    navSignIn: 'Hyrje',
    headline: ['Çdo telefonatë e humbur', 'është një termin i humbur.'],
    lede: 'Frontly përgjigjet kur ju nuk mundeni, kupton shqip dhe rezervon në kalendarin tuaj. Pa postë zanore dhe pa klientë të humbur.',
    contactCta: 'Kërkoni një demo',
    contactFine: 'Biznes i ri? Na shkruani dhe ju rregullojmë ne.',
    exchangeLabel: 'Telefonatë e vërtetë (maqedonisht)',
    bandTitle: 'Bie. Përgjigjet. Rezervon.',
    band: [
      [
        'Përgjigjet që në ziljen e parë',
        ', edhe kur jeni me një klient, të shtunën ose në tre të mëngjesit.',
        '',
      ],
      [
        'Kontrollon orare vërtet të lira',
        ' sipas orarit të punës, shërbimit dhe personit që e kryen.',
        '',
      ],
      ['E lexon numrin mbrapsht', ' shifër për shifër dhe pret konfirmim para se të rezervojë.', ''],
    ],
    facts: [
      ['Gjuhë', '3', 'Maqedonisht, shqip, anglisht.'],
      ['Disponueshmëri', '24/7', 'Asnjë telefonatë e humbur, asnjë postë zanore.'],
      ['Kosto për bisedë', '$0.39', 'E matur në një telefonatë reale, jo e vlerësuar.'],
    ],
    signInTitle: 'Punoni tashmë me ne?',
    signInBody:
      'Hyni në panel për të parë telefonatat, terminet dhe çfarë tha secili klient.',
    signInCta: 'Hyrje',
    footer: 'Recepsionist virtual për biznese të vogla në Maqedoninë e Veriut.',
  },

  en: {
    eyebrow: 'Clinics · Salons · Auto services',
    navSignIn: 'Sign in',
    headline: ['Every missed call', 'is a lost booking.'],
    lede: 'Frontly answers when you cannot, understands Macedonian and books into your calendar. No voicemail, no lost customers.',
    contactCta: 'Request a demo',
    contactFine: 'New business? Write to us and we will set you up.',
    exchangeLabel: 'A real call (in Macedonian)',
    bandTitle: 'Rings. Answers. Books.',
    band: [
      ['Answers on the first ring', ', even mid-customer, on a Saturday, or at three in the morning.', ''],
      [
        'Checks genuinely free times',
        ' against opening hours, the service, and who performs it.',
        '',
      ],
      ['Reads the number back', ' digit by digit and waits for confirmation before booking.', ''],
    ],
    facts: [
      ['Languages', '3', 'Macedonian, Albanian, English.'],
      ['Availability', '24/7', 'No missed calls and no voicemail.'],
      ['Cost per conversation', '$0.39', 'Measured on a real call, not estimated.'],
    ],
    signInTitle: 'Already working with us?',
    signInBody: 'Sign in to see the calls, the appointments, and what every customer said.',
    signInCta: 'Sign in',
    footer: 'A virtual receptionist for small businesses in North Macedonia.',
  },
};
