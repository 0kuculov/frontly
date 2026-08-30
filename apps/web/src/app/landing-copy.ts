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
  navPhone: string;
  navSignIn: string;
  /** Two lines, and they are two lines on purpose — see the <br> in the page. */
  headline: [string, string];
  lede: string;
  cta: string;
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
  newClinic: (phone: string) => string;
  footer: string;
}

export const LANDING: Record<Lang, LandingCopy> = {
  mk: {
    navPhone: 'Телефон',
    navSignIn: 'Најава',
    headline: ['Вашата ординација', 'не пропушта повик.'],
    lede: 'Frontly се јавува, разбира македонски и закажува во вашиот календар. Секој ден, во секое време.',
    cta: 'Јавете се и пробајте',
    exchangeLabel: 'Вистински повик',
    bandTitle: 'Ѕвони. Одговара. Закажува.',
    band: [
      [
        'Се јавува на првото ѕвонење',
        ', дури и кога сте со пациент, во сабота или во три наутро.',
        '',
      ],
      [
        'Проверува вистински слободни термини',
        ' според работното време, услугата и кој доктор ја работи.',
        '',
      ],
      ['Го прочитува бројот назад', ' цифра по цифра и чека потврда пред да закажe.', ''],
    ],
    facts: [
      ['Јазици', '3', 'Македонски, албански, англиски.'],
      ['Достапност', '24/7', 'Без пропуштен повик и без говорна пошта.'],
      ['Цена по разговор', '$0.39', 'Измерено на вистински повик, не проценето.'],
    ],
    signInTitle: 'Веќе имате ординација кај нас?',
    signInBody:
      'Влезете во таблата за да ги видите повиците, термините и што кажал секој пациент.',
    signInCta: 'Најава',
    newClinic: (phone) => `Нова ординација? Јавете се на ${phone} и ве поставуваме ние.`,
    footer: 'Виртуелен рецепционер за мали ординации во Северна Македонија.',
  },

  sq: {
    navPhone: 'Telefoni',
    navSignIn: 'Hyrje',
    headline: ['Klinika juaj', 'nuk humb asnjë telefonatë.'],
    lede: 'Frontly përgjigjet, kupton shqip dhe rezervon në kalendarin tuaj. Çdo ditë, në çdo orë.',
    cta: 'Telefononi dhe provojeni',
    exchangeLabel: 'Telefonatë e vërtetë (maqedonisht)',
    bandTitle: 'Bie. Përgjigjet. Rezervon.',
    band: [
      [
        'Përgjigjet që në ziljen e parë',
        ', edhe kur jeni me një pacient, të shtunën ose në tre të mëngjesit.',
        '',
      ],
      [
        'Kontrollon orare vërtet të lira',
        ' sipas orarit të punës, shërbimit dhe mjekut që e kryen.',
        '',
      ],
      ['E lexon numrin mbrapsht', ' shifër për shifër dhe pret konfirmim para se të rezervojë.', ''],
    ],
    facts: [
      ['Gjuhë', '3', 'Maqedonisht, shqip, anglisht.'],
      ['Disponueshmëri', '24/7', 'Asnjë telefonatë e humbur, asnjë postë zanore.'],
      ['Kosto për bisedë', '$0.39', 'E matur në një telefonatë reale, jo e vlerësuar.'],
    ],
    signInTitle: 'Keni tashmë një klinikë me ne?',
    signInBody:
      'Hyni në panel për të parë telefonatat, terminet dhe çfarë tha secili pacient.',
    signInCta: 'Hyrje',
    newClinic: (phone) => `Klinikë e re? Telefononi ${phone} dhe ju rregullojmë ne.`,
    footer: 'Recepsionist virtual për klinika të vogla në Maqedoninë e Veriut.',
  },

  en: {
    navPhone: 'Phone',
    navSignIn: 'Sign in',
    headline: ['Your clinic never', 'misses a call.'],
    lede: 'Frontly answers, understands Macedonian and books into your calendar. Every day, at any hour.',
    cta: 'Call it and see',
    exchangeLabel: 'A real call (in Macedonian)',
    bandTitle: 'Rings. Answers. Books.',
    band: [
      ['Answers on the first ring', ', even mid-patient, on a Saturday, or at three in the morning.', ''],
      [
        'Checks genuinely free times',
        ' against opening hours, the service, and which dentist performs it.',
        '',
      ],
      ['Reads the number back', ' digit by digit and waits for confirmation before booking.', ''],
    ],
    facts: [
      ['Languages', '3', 'Macedonian, Albanian, English.'],
      ['Availability', '24/7', 'No missed calls and no voicemail.'],
      ['Cost per conversation', '$0.39', 'Measured on a real call, not estimated.'],
    ],
    signInTitle: 'Already have a clinic with us?',
    signInBody: 'Sign in to see the calls, the appointments, and what every patient said.',
    signInCta: 'Sign in',
    newClinic: (phone) => `New clinic? Call ${phone} and we will set you up.`,
    footer: 'A virtual receptionist for small clinics in North Macedonia.',
  },
};
