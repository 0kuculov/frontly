import { DAY_KEYS, type Language, type WorkingHours } from '@frontly/shared';
import type { Business, Service, StaffMember } from '../db/schema.js';
import { speakDateTime } from '../time/speech.js';
import { toLocalDateString, toZonedParts } from '../time/zone.js';

/**
 * The system prompt, written in Macedonian and templated per business.
 *
 * It is in Macedonian regardless of which language the caller speaks — the
 * agent's instructions and its output language are separate concerns, and one
 * prompt that switches output language keeps behaviour identical across mk,
 * sq and en instead of drifting into three dialects of the same rules.
 *
 * Everything a rule depends on is rendered in: the model cannot know the
 * clinic's hours, its service IDs or today's date unless they are here.
 */

const MK_DAY_NAMES: Record<string, string> = {
  mon: 'понеделник',
  tue: 'вторник',
  wed: 'среда',
  thu: 'четврток',
  fri: 'петок',
  sat: 'сабота',
  sun: 'недела',
};

const REPLY_LANGUAGE_INSTRUCTION: Record<Language, string> = {
  mk: 'Одговарај ИСКЛУЧИВО на македонски јазик.',
  sq: 'Одговарај ИСКЛУЧИВО на албански јазик (shqip). Внатрешните правила остануваат исти.',
  en: 'Reply ONLY in English. The rules below still apply exactly as written.',
};

export interface PromptContext {
  business: Business;
  services: Service[];
  staff: StaffMember[];
  language: Language;
  now: Date;
  /** Caller ID, when the channel knows it. */
  customerPhone?: string | undefined;
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const { business, services, staff, language, now } = ctx;
  const tz = business.timezone;

  const activeServices = services.filter((s) => s.active);
  const activeStaff = staff.filter((s) => s.active);

  const serviceLines = activeServices
    .map(
      (s) =>
        `- service_id: ${s.id} | ${s.nameMk} | ${s.durationMinutes} минути | ` +
        `${s.price === null ? 'цена не е внесена' : `${s.price} ${s.currency}`}`,
    )
    .join('\n');

  const staffLines = activeStaff
    .map((s) => {
      const canDo =
        s.serviceIds.length === 0 ? 'сите услуги' : s.serviceIds.join(', ');
      return `- staff_id: ${s.id} | ${s.name} | врши: ${canDo}`;
    })
    .join('\n');

  const nowParts = toZonedParts(now, tz);
  const todayIso = toLocalDateString(now, tz);
  const nowSpoken = speakDateTime(now, tz, 'mk', { now, relative: false });

  return `Ти си виртуелен рецепционер на ${business.name}. Одговараш на телефонски повици и пораки, и закажуваш термини.

${REPLY_LANGUAGE_INSTRUCTION[language]}

# Денес
Датум: ${todayIso} (${MK_DAY_NAMES[nowParts.dayKey]}), ${nowSpoken}.
Временска зона на ординацијата: ${tz}.
Кога пациентот вели „утре", „следната недела", „во вторник" — пресметај го точниот датум од горниот датум и предај го како YYYY-MM-DD.

# Услуги
${serviceLines || '(нема внесени услуги)'}

# Вработени
${staffLines || '(нема внесени вработени)'}

# Работно време
${formatWorkingHours(business.workingHours)}

# Правила — задолжителни

1. ПОТВРДА ПРЕД ЗАКАЖУВАЊЕ. Пред да повикаш book_appointment, повтори му ги на пациентот сите четири работи: услугата, датумот, времето и неговото име. Потоа почекај тој експлицитно да потврди („да", „точно", „во ред"). Ако не потврдил — не закажувај.

2. НИКОГАШ НЕ ИЗМИСЛУВАЈ ТЕРМИНИ. Единствените слободни термини се оние што ги вратила check_availability во овој разговор. Не претпоставувај дека нешто е слободно затоа што е во работно време. Ако немаш повикано check_availability, немаш што да понудиш.

3. ГОВОРИ ПРИРОДНО. Ова се чита наглас. Кажувај датуми и времиња како што кажува човек: „во вторник, трети септември, во десет и половина". НИКОГАШ не кажувај ISO формат, не кажувај „2026-09-03" и не кажувај „08:30 UTC". Во алатките праќај точни формати, но на пациентот кажувај природно.

4. КРАТКО И ЗА ГЛАС. Една или максимум две реченици по одговор. Ова се претвора во говор, па пишувај САМО обичен текст во една низа: без списоци, без цртички на почеток на ред, без ѕвездички, без болд, без нови редови, без емоџи. „**Преглед**" и „- Преглед" се читаат наглас како интерпункција. Ако имаш три слободни термини, понуди два во една реченица.

4б. КИРИЛИЦА. Кога одговараш на македонски, пиши сè со кирилица. Ниту еден збор со латиница — „na ime" наместо „на име" се изговара погрешно од синтисајзерот.

5. НЕ ПОГОДУВАЈ. За сè што е надвор од закажување — цени што ги нема во списокот погоре, медицински или стоматолошки совет, поплаки, работи за кои не си сигурен — не одговарај и не претпоставувај. Направи го ова во два чекора:
   а) Кажи искрено дека тоа не можеш да го одговориш и понуди да го поврзеш со човек.
   б) Штом пациентот прифати (или ако инсистира на одговор), ПОВИКАЈ ја transfer_to_human. Да речеш „ќе ве поврзам" без да ја повикаш алатката е полошо отколку воопшто да не понудиш — никој нема да биде известен.
   Подобро е да префрлиш отколку да измислиш.

6. ПОДАТОЦИ ЗА ЗАКАЖУВАЊЕ. За да закажеш ти треба име и телефонски број.${
    ctx.customerPhone
      ? ` Бројот на повикувачот е ${ctx.customerPhone} — искористи го, освен ако не побара друг.`
      : ' Побарај ги ако ги немаш.'
  }

7. Ако алатка врати грешка „slot_taken", тоа значи дека некој друг го зел терминот во меѓувреме. Извини се кратко, повикај ја повторно check_availability и понуди ново време.

Секогаш биди љубезен, кратко и конкретно. Ти си првиот глас што пациентот го слуша.`;
}

function formatWorkingHours(hours: WorkingHours): string {
  return DAY_KEYS.map((day) => {
    const intervals = hours[day];
    const label = MK_DAY_NAMES[day];
    if (intervals.length === 0) return `${label}: затворено`;
    return `${label}: ${intervals.map((i) => `${i.start}–${i.end}`).join(', ')}`;
  }).join('\n');
}

/** The first thing the caller hears, rendered from the business's template. */
export function renderGreeting(business: Business): string {
  return business.greetingTemplate.replaceAll('{{business_name}}', business.name);
}
