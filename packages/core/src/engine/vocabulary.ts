import type { Language } from '@frontly/shared';
import type { Business, Service, StaffMember } from '../db/schema.js';
import { calendarVocabulary } from '../time/speech.js';
import { serviceName } from './executor.js';

/**
 * What the caller is likely to say, handed to the recognizer as a phrase list.
 *
 * A receptionist for one dental clinic hears a tiny vocabulary: a handful of
 * service names, two doctors, days, times, and a dozen booking phrases. Over
 * an 8 kHz line — worse still through a VoIP app that transcodes a second time
 * — a general-purpose model has to guess among every Macedonian word. Telling
 * it which few hundred actually occur is the single biggest accuracy lever
 * available without changing provider.
 *
 * Built from the business's own database record, so a clinic with different
 * services or staff gets a different list with no code change.
 */

/** Azure's documented ceiling. Past this, Custom Speech is the right tool. */
export const MAX_PHRASES = 500;

/** Booking language a caller uses regardless of which clinic they rang. */
const BOOKING_PHRASES: Record<Language, readonly string[]> = {
  mk: [
    'сакам да закажам',
    'сакам термин',
    'да закажам термин',
    'имате ли слободно',
    'може ли',
    'кога имате',
    'колку чини',
    'се викам',
    'моето име е',
    'да, потврдувам',
    'потврдувам',
    'во ред',
    'точно',
    'не може',
    'да откажам',
    'откажи го терминот',
    'да го поместам',
    'друг термин',
    'порано',
    'подоцна',
    'преглед',
    'термин',
    'доктор',
    'докторка',
    'наутро',
    'попладне',
    'здраво',
    'добар ден',
    'добро утро',
    'ви благодарам',
    'до гледање',
  ],
  sq: [
    'dua të rezervoj',
    'dua një takim',
    'a keni kohë',
    'a mund të',
    'sa kushton',
    'quhem',
    'po, konfirmoj',
    'konfirmoj',
    'në rregull',
    'anuloj takimin',
    'takim',
    'kontroll',
    'doktor',
    'mirëdita',
    'faleminderit',
  ],
  en: [
    'I would like to book',
    'I need an appointment',
    'do you have anything',
    'how much does it cost',
    'my name is',
    'yes, I confirm',
    'that is correct',
    'cancel my appointment',
    'reschedule',
    'appointment',
    'check-up',
    'doctor',
    'thank you',
  ],
};

export interface VocabularyInput {
  business: Business;
  services: Service[];
  staff: StaffMember[];
  language: Language;
}

/**
 * Names, split into their parts as well as kept whole.
 *
 * "д-р Ана Смилевска" is one phrase, but a caller says "кај Ана" or
 * "докторката Смилевска" — biasing only the full string helps neither.
 */
function nameVariants(full: string): string[] {
  const trimmed = full.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 2 && !/^д-?р\.?$/i.test(p));
  return [trimmed, ...parts];
}

export function recognitionPhrases(input: VocabularyInput): string[] {
  const { business, services, staff, language } = input;

  const phrases = [
    business.name,
    ...nameVariants(business.name),
    ...services.flatMap((service) => {
      const name = serviceName(service, language);
      return [name, ...name.split(/\s+/).filter((word: string) => word.length > 3)];
    }),
    ...staff.flatMap((member) => nameVariants(member.name)),
    ...calendarVocabulary(language),
    ...BOOKING_PHRASES[language],
  ];

  // Deduplicate case-insensitively, keep the first spelling, and stay under
  // the documented ceiling.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const phrase of phrases) {
    const key = phrase.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(phrase.trim());
    if (unique.length >= MAX_PHRASES) break;
  }
  return unique;
}
