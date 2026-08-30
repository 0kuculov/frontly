import type { Lang } from './session';

/**
 * Three languages, one dictionary, no library.
 *
 * The dashboard is Macedonian. Albanian is there because roughly a quarter of
 * this country speaks it and a receptionist product that answers the phone in
 * Albanian and then hands the owner a Macedonian-only dashboard is telling
 * them which half of the market it was built for. English exists so a judge or
 * an investor reading over a shoulder is not locked out.
 *
 * Still no i18n runtime: three languages and ~75 strings is a dictionary, and
 * the type system already refuses a missing translation — `Record<Lang, ...>`
 * means adding a language turns every gap into a compile error rather than a
 * blank on screen.
 *
 * Written mk-first on purpose. A dictionary keyed by English sentences quietly
 * makes English the real language and everything else the translation, and
 * this product is the other way round.
 *
 * The Albanian was written against the phrasing tables the voice channel
 * already round-trips through TTS, and it has NOT been read by a native
 * speaker. Every string is grammatical; that is not the same as sounding right
 * to somebody from Tetovo, and it is worth twenty minutes with one before the
 * demo.
 */

export const DICT = {
  // --- navigation
  today: { mk: 'Денес', sq: 'Sot', en: 'Today' },
  welcome: { mk: 'Добредојде', sq: 'Mirë se vini', en: 'Welcome' },
  conversations: { mk: 'Разговори', sq: 'Bisedat', en: 'Conversations' },
  calendar: { mk: 'Календар', sq: 'Kalendari', en: 'Calendar' },
  settings: { mk: 'Поставки', sq: 'Cilësimet', en: 'Settings' },
  signOut: { mk: 'Одјава', sq: 'Dilni', en: 'Sign out' },

  // --- today
  todaySchedule: { mk: 'Распоред за денес', sq: 'Orari i sotëm', en: "Today's schedule" },
  noAppointments: { mk: 'Нема закажани термини денес.', sq: 'Nuk ka termine sot.', en: 'No appointments today.' },
  nothingYet: { mk: 'Сè уште нема повици денес.', sq: 'Ende asnjë telefonatë sot.', en: 'No calls yet today.' },
  handledToday: { mk: 'Повици денес', sq: 'Telefonata sot', en: 'Calls today' },
  bookedToday: { mk: 'Закажани', sq: 'Të rezervuara', en: 'Booked' },
  forYou: { mk: 'За вас', sq: 'Për ju', en: 'For you' },
  appointmentsToday: { mk: 'Термини', sq: 'Termine', en: 'Appointments' },
  now: { mk: 'сега', sq: 'tani', en: 'now' },
  gap: { mk: 'пауза', sq: 'pauzë', en: 'gap' },

  // --- conversations
  allConversations: { mk: 'Сите разговори', sq: 'Të gjitha bisedat', en: 'All conversations' },
  caller: { mk: 'Повикувач', sq: 'Telefonuesi', en: 'Caller' },
  when: { mk: 'Кога', sq: 'Kur', en: 'When' },
  duration: { mk: 'Траење', sq: 'Kohëzgjatja', en: 'Duration' },
  outcome: { mk: 'Исход', sq: 'Rezultati', en: 'Outcome' },
  language: { mk: 'Јазик', sq: 'Gjuha', en: 'Language' },
  response: { mk: 'Одговор', sq: 'Përgjigja', en: 'Response' },
  transcript: { mk: 'Транскрипт', sq: 'Transkripti', en: 'Transcript' },
  back: { mk: 'Назад', sq: 'Kthehu', en: 'Back' },
  agent: { mk: 'Фронтли', sq: 'Frontly', en: 'Frontly' },
  customer: { mk: 'Пациент', sq: 'Pacienti', en: 'Patient' },
  noConversations: { mk: 'Сè уште нема разговори.', sq: 'Ende asnjë bisedë.', en: 'No conversations yet.' },
  turns: { mk: 'реплики', sq: 'replika', en: 'turns' },

  // --- outcomes
  outcomeBooked: { mk: 'Закажано', sq: 'E rezervuar', en: 'Booked' },
  outcomeInfo: { mk: 'Информација', sq: 'U përgjigj', en: 'Answered' },
  outcomeTransferred: { mk: 'Префрлено', sq: 'Transferuar', en: 'Transferred' },
  outcomeAbandoned: { mk: 'Прекинато', sq: 'Ndërprerë', en: 'Abandoned' },
  outcomeCancelled: { mk: 'Откажано', sq: 'Anuluar', en: 'Cancelled' },
  outcomeRescheduled: { mk: 'Одложено', sq: 'Shtyrë', en: 'Rescheduled' },
  outcomeOpen: { mk: 'Во тек', sq: 'Në vazhdim', en: 'Open' },

  // --- calendar
  week: { mk: 'Недела', sq: 'Java', en: 'Week' },
  previous: { mk: 'Претходна', sq: 'E mëparshme', en: 'Previous' },
  next: { mk: 'Следна', sq: 'Tjetra', en: 'Next' },
  thisWeek: { mk: 'Оваа недела', sq: 'Kjo javë', en: 'This week' },
  closed: { mk: 'затворено', sq: 'mbyllur', en: 'closed' },

  // --- settings
  clinic: { mk: 'Ординација', sq: 'Klinika', en: 'Clinic' },
  clinicName: { mk: 'Име', sq: 'Emri', en: 'Name' },
  greeting: { mk: 'Поздрав', sq: 'Përshëndetja', en: 'Greeting' },
  greetingHelp: {
    mk: 'Првото што го слуша пациентот. {{business_name}} се заменува со името.',
    sq: 'Gjëja e parë që dëgjon pacienti. {{business_name}} zëvendësohet me emrin.',
    en: 'The first thing a caller hears. {{business_name}} is replaced with the name.',
  },
  ownerMobile: { mk: 'Мобилен на сопственик', sq: 'Celulari i pronarit', en: 'Owner mobile' },
  ownerMobileHelp: {
    mk: 'Каде оди префрлањето и дневниот преглед. Празно значи дека нема префрлање.',
    sq: 'Ku shkojnë transferimet dhe përmbledhja ditore. Bosh do të thotë pa transferim.',
    en: 'Where transfers and the daily summary go. Empty means no transfer route.',
  },
  languages: { mk: 'Јазици', sq: 'Gjuhët', en: 'Languages' },
  languagesHelp: {
    mk: 'Првиот е основниот. Јазикот се препознава од првата реченица на повикот.',
    sq: 'E para është e parazgjedhura. Gjuha njihet nga fjalia e parë e telefonatës.',
    en: 'The first is the default. The language is detected from the first sentence of a call.',
  },
  workingHours: { mk: 'Работно време', sq: 'Orari i punës', en: 'Working hours' },
  services: { mk: 'Услуги', sq: 'Shërbimet', en: 'Services' },
  staff: { mk: 'Вработени', sq: 'Stafi', en: 'Staff' },
  save: { mk: 'Зачувај', sq: 'Ruaj', en: 'Save' },
  saved: { mk: 'Зачувано', sq: 'U ruajt', en: 'Saved' },
  saveFailed: { mk: 'Не се зачува', sq: 'Nuk u ruajt', en: 'Not saved' },
  readOnlyHere: { mk: 'Се менуваат надвор од таблата', sq: 'Menaxhohen jashtë panelit', en: 'Managed outside the dashboard' },
  minutes: { mk: 'мин', sq: 'min', en: 'min' },
  phoneNumber: { mk: 'Телефонски број', sq: 'Numri i telefonit', en: 'Phone number' },

  // --- login
  signIn: { mk: 'Најава', sq: 'Hyrje', en: 'Sign in' },
  email: { mk: 'Е-пошта', sq: 'Email', en: 'Email' },
  password: { mk: 'Лозинка', sq: 'Fjalëkalimi', en: 'Password' },
  signInFailed: {
    mk: 'Погрешна е-пошта или лозинка.',
    sq: 'Email-i ose fjalëkalimi nuk përputhen.',
    en: 'That email and password do not match.',
  },
  signInUnreachable: {
    mk: 'Серверот не одговара. Стартувај го со „pnpm dev:api“ и обиди се повторно.',
    sq: 'Serveri nuk përgjigjet. Nisni atë me "pnpm dev:api" dhe provoni përsëri.',
    en: 'The API is not answering. Start it with "pnpm dev:api" and try again.',
  },
  signInTagline: {
    mk: 'AI рецепционер што одговара на повици и закажува термини.',
    sq: 'Recepsionist me AI që përgjigjet në telefonata dhe rezervon termine.',
    en: 'An AI receptionist that answers calls and books appointments.',
  },
} as const;

export type DictKey = keyof typeof DICT;

export function t(key: DictKey, lang: Lang): string {
  return DICT[key][lang];
}

/** A translator bound to one language, so components read `t('today')`. */
export function translator(lang: Lang) {
  return (key: DictKey): string => DICT[key][lang];
}

const OUTCOME_KEYS: Record<string, DictKey> = {
  booked: 'outcomeBooked',
  info: 'outcomeInfo',
  transferred: 'outcomeTransferred',
  abandoned: 'outcomeAbandoned',
  cancelled: 'outcomeCancelled',
  rescheduled: 'outcomeRescheduled',
};

/**
 * "1 термин", not "1 термини".
 *
 * All three languages here happen to need only a singular and a plural, so
 * this is a pair per language rather than an Intl.PluralRules setup — but it
 * is a function precisely so that the day a language needing more forms
 * arrives, there is one place to change instead of a template literal in every
 * page.
 */
const APPOINTMENT_WORD: Record<Lang, [one: string, many: string]> = {
  mk: ['термин', 'термини'],
  sq: ['termin', 'termine'],
  en: ['appointment', 'appointments'],
};

export function appointmentWord(count: number, lang: Lang): string {
  const [one, many] = APPOINTMENT_WORD[lang];
  return count === 1 ? one : many;
}

export function outcomeLabel(outcome: string | null, lang: Lang): string {
  if (!outcome) return t('outcomeOpen', lang);
  const key = OUTCOME_KEYS[outcome];
  return key ? t(key, lang) : outcome;
}

const DAY_LABELS: Record<string, Record<Lang, string>> = {
  mon: { mk: 'Понеделник', sq: 'E hënë', en: 'Monday' },
  tue: { mk: 'Вторник', sq: 'E martë', en: 'Tuesday' },
  wed: { mk: 'Среда', sq: 'E mërkurë', en: 'Wednesday' },
  thu: { mk: 'Четврток', sq: 'E enjte', en: 'Thursday' },
  fri: { mk: 'Петок', sq: 'E premte', en: 'Friday' },
  sat: { mk: 'Сабота', sq: 'E shtunë', en: 'Saturday' },
  sun: { mk: 'Недела', sq: 'E diel', en: 'Sunday' },
};

export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export function dayLabel(day: string, lang: Lang): string {
  return DAY_LABELS[day]?.[lang] ?? day;
}

/**
 * Dates are formatted with Intl against the CLINIC's timezone, never the
 * browser's. An owner checking the dashboard from abroad must still see the
 * clinic's day, or the times on screen do not match the times on the phone.
 */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * The BCP-47 tag for each language, in one place.
 *
 * Intl is what renders every date on every screen, so a language added to the
 * dictionary but not to this map would silently render its dates in English
 * and look like a translation someone forgot to finish.
 */
export const LOCALES: Record<Lang, string> = {
  mk: 'mk-MK',
  sq: 'sq-AL',
  en: 'en-GB',
};

export function formatDate(iso: string, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    timeZone,
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}

export function formatDuration(ms: number | null, lang: Lang): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}${lang === 'mk' ? 'с' : 's'}`;  // sq and en both use 's'
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
