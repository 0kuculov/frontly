import type { Lang } from './session';

/**
 * Two languages, one dictionary, no library.
 *
 * The dashboard is Macedonian; English exists so a judge or an investor
 * reading over the owner's shoulder is not locked out. That is a narrow job,
 * and a full i18n runtime for two languages and ~70 strings would be more
 * machinery than content.
 *
 * Written mk-first on purpose. A dictionary keyed by English sentences quietly
 * makes English the real language and Macedonian the translation, and this
 * product is the other way round.
 */

export const DICT = {
  // --- navigation
  today: { mk: 'Денес', en: 'Today' },
  conversations: { mk: 'Разговори', en: 'Conversations' },
  calendar: { mk: 'Календар', en: 'Calendar' },
  settings: { mk: 'Поставки', en: 'Settings' },
  signOut: { mk: 'Одјава', en: 'Sign out' },

  // --- today
  todaySchedule: { mk: 'Распоред за денес', en: "Today's schedule" },
  noAppointments: { mk: 'Нема закажани термини денес.', en: 'No appointments today.' },
  nothingYet: { mk: 'Сè уште нема повици денес.', en: 'No calls yet today.' },
  handledToday: { mk: 'Повици денес', en: 'Calls today' },
  bookedToday: { mk: 'Закажани', en: 'Booked' },
  forYou: { mk: 'За вас', en: 'For you' },
  appointmentsToday: { mk: 'Термини', en: 'Appointments' },
  now: { mk: 'сега', en: 'now' },
  gap: { mk: 'пауза', en: 'gap' },

  // --- conversations
  allConversations: { mk: 'Сите разговори', en: 'All conversations' },
  caller: { mk: 'Повикувач', en: 'Caller' },
  when: { mk: 'Кога', en: 'When' },
  duration: { mk: 'Траење', en: 'Duration' },
  outcome: { mk: 'Исход', en: 'Outcome' },
  language: { mk: 'Јазик', en: 'Language' },
  response: { mk: 'Одговор', en: 'Response' },
  transcript: { mk: 'Транскрипт', en: 'Transcript' },
  back: { mk: 'Назад', en: 'Back' },
  agent: { mk: 'Фронтли', en: 'Frontly' },
  customer: { mk: 'Пациент', en: 'Patient' },
  noConversations: { mk: 'Сè уште нема разговори.', en: 'No conversations yet.' },
  turns: { mk: 'реплики', en: 'turns' },

  // --- outcomes
  outcomeBooked: { mk: 'Закажано', en: 'Booked' },
  outcomeInfo: { mk: 'Информација', en: 'Answered' },
  outcomeTransferred: { mk: 'Префрлено', en: 'Transferred' },
  outcomeAbandoned: { mk: 'Прекинато', en: 'Abandoned' },
  outcomeCancelled: { mk: 'Откажано', en: 'Cancelled' },
  outcomeRescheduled: { mk: 'Одложено', en: 'Rescheduled' },
  outcomeOpen: { mk: 'Во тек', en: 'Open' },

  // --- calendar
  week: { mk: 'Недела', en: 'Week' },
  previous: { mk: 'Претходна', en: 'Previous' },
  next: { mk: 'Следна', en: 'Next' },
  thisWeek: { mk: 'Оваа недела', en: 'This week' },
  closed: { mk: 'затворено', en: 'closed' },

  // --- settings
  clinic: { mk: 'Ординација', en: 'Clinic' },
  clinicName: { mk: 'Име', en: 'Name' },
  greeting: { mk: 'Поздрав', en: 'Greeting' },
  greetingHelp: {
    mk: 'Првото што го слуша пациентот. {{business_name}} се заменува со името.',
    en: 'The first thing a caller hears. {{business_name}} is replaced with the name.',
  },
  ownerMobile: { mk: 'Мобилен на сопственик', en: 'Owner mobile' },
  ownerMobileHelp: {
    mk: 'Каде оди префрлањето и дневниот преглед. Празно значи дека нема префрлање.',
    en: 'Where transfers and the daily summary go. Empty means no transfer route.',
  },
  languages: { mk: 'Јазици', en: 'Languages' },
  languagesHelp: {
    mk: 'Првиот е основниот. Јазикот се препознава од првата реченица на повикот.',
    en: 'The first is the default. The language is detected from the first sentence of a call.',
  },
  workingHours: { mk: 'Работно време', en: 'Working hours' },
  services: { mk: 'Услуги', en: 'Services' },
  staff: { mk: 'Вработени', en: 'Staff' },
  save: { mk: 'Зачувај', en: 'Save' },
  saved: { mk: 'Зачувано', en: 'Saved' },
  saveFailed: { mk: 'Не се зачува', en: 'Not saved' },
  readOnlyHere: { mk: 'Се менуваат надвор од таблата', en: 'Managed outside the dashboard' },
  minutes: { mk: 'мин', en: 'min' },
  phoneNumber: { mk: 'Телефонски број', en: 'Phone number' },

  // --- login
  signIn: { mk: 'Најава', en: 'Sign in' },
  email: { mk: 'Е-пошта', en: 'Email' },
  password: { mk: 'Лозинка', en: 'Password' },
  signInFailed: {
    mk: 'Погрешна е-пошта или лозинка.',
    en: 'That email and password do not match.',
  },
  signInTagline: {
    mk: 'AI рецепционер што одговара на повици и закажува термини.',
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

export function outcomeLabel(outcome: string | null, lang: Lang): string {
  if (!outcome) return t('outcomeOpen', lang);
  const key = OUTCOME_KEYS[outcome];
  return key ? t(key, lang) : outcome;
}

const DAY_LABELS: Record<string, { mk: string; en: string }> = {
  mon: { mk: 'Понеделник', en: 'Monday' },
  tue: { mk: 'Вторник', en: 'Tuesday' },
  wed: { mk: 'Среда', en: 'Wednesday' },
  thu: { mk: 'Четврток', en: 'Thursday' },
  fri: { mk: 'Петок', en: 'Friday' },
  sat: { mk: 'Сабота', en: 'Saturday' },
  sun: { mk: 'Недела', en: 'Sunday' },
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

export function formatDate(iso: string, timeZone: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'mk' ? 'mk-MK' : 'en-GB', {
    timeZone,
    day: 'numeric',
    month: 'long',
  }).format(new Date(iso));
}

export function formatDuration(ms: number | null, lang: Lang): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}${lang === 'mk' ? 'с' : 's'}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
