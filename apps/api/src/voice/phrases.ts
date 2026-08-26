import type { Language } from '@frontly/shared';

/**
 * Everything the agent says that the model did not write.
 *
 * Collected in one file because these are the lines a caller hears when
 * something has gone wrong, and they are the ones most likely to need a native
 * speaker's eye before the demo. They are also the only strings that can be
 * synthesized ahead of time, since they never change.
 */

/**
 * Said when STT is unsure or Azure failed. Never silence, never garbage.
 *
 * Escalating, like the reprompts, and for the same reason: the caller hearing
 * the identical apology twice is what makes a bad line feel like a loop. The
 * second one asks for less, because the first attempt at the full question is
 * evidently not getting through.
 */
export const DID_NOT_CATCH: Record<Language, readonly string[]> = {
  mk: [
    'Извинете, не ве слушнав добро. Може ли да повторите?',
    'Сè уште не ве слушам добро. Кажете ми само датумот и времето, полека.',
  ],
  sq: [
    'Më falni, nuk ju dëgjova mirë. A mund ta përsërisni?',
    'Ende nuk ju dëgjoj mirë. Më thoni vetëm datën dhe orën, ngadalë.',
  ],
  en: [
    'Sorry, I did not catch that. Could you repeat it?',
    'I still cannot hear you clearly. Just the day and the time, slowly.',
  ],
};

/**
 * Said when the line is genuinely too poor to continue.
 *
 * A caller the system cannot hear gets a way out rather than another attempt
 * at the same question. Spoken before the transfer or callback offer, so the
 * caller knows why the call is ending.
 */
export const CANNOT_HEAR: Record<Language, string> = {
  mk: 'Извинете, врската е слаба и не можам да ве слушнам добро.',
  sq: 'Më falni, lidhja është e dobët dhe nuk po ju dëgjoj mirë.',
  en: 'Sorry, the line is poor and I cannot hear you clearly.',
};

/**
 * Checking whether the caller is still on the line.
 *
 * Several per language, escalating, and never repeated verbatim: hearing the
 * identical sentence twice is what makes the agent feel like a stuck loop
 * rather than a person checking in. The last one names the way out, so a
 * caller who can hear but cannot get a word in knows what happens next.
 */
export const REPROMPTS: Record<Language, readonly string[]> = {
  mk: [
    'Сè уште сте тука?',
    'Ме слушате ли? Ако сакате, можам да ве поврзам со колега.',
  ],
  sq: [
    'Jeni ende aty?',
    'A më dëgjoni? Nëse doni, mund t’ju lidh me një koleg.',
  ],
  en: [
    'Are you still there?',
    'Can you hear me? I can put you through to a colleague if that is easier.',
  ],
};

/**
 * Said when the agent wanted a human and could not reach one. It promises a
 * call back rather than claiming a transfer that did not happen — an agent
 * caught lying about this on stage is worse than one that admits a limit.
 */
export const TRANSFER_UNAVAILABLE: Record<Language, string> = {
  mk: 'Во моментов не можам да ве префрлам. Ќе замолам колега да ви се јави на овој број. Пријатен ден.',
  sq: 'Për momentin nuk mund t’ju transferoj. Do të kërkoj një koleg t’ju telefonojë në këtë numër. Ditë të mbarë.',
  en: 'I cannot put you through right now. I will ask a colleague to call you back on this number. Have a good day.',
};

export const CALLBACK_OFFER: Record<Language, string> = {
  mk: 'Изгледа дека врската не е добра. Ќе замолам колега да ви се јави. Пријатен ден.',
  sq: 'Duket se lidhja nuk është e mirë. Do të kërkoj një koleg t’ju telefonojë. Ditë të mbarë.',
  en: 'The line seems poor. I will ask a colleague to call you back. Have a good day.',
};

/**
 * Spoken only when the model concluded the call but said nothing to conclude
 * it with.
 *
 * `end_call` is meant to arrive alongside a goodbye in the same message, and
 * normally does. If it ever arrives alone, the caller would otherwise hear the
 * line simply go dead — which is indistinguishable from a dropped call, and on
 * stage would read as a crash. Cached, so it costs ~35ms rather than a round
 * trip to Azure at the one moment nobody is willing to wait.
 */
export const FAREWELL: Record<Language, string> = {
  mk: 'Ви благодарам што се јавивте. Пријатен ден.',
  sq: 'Faleminderit që telefonuat. Ditë të mbarë.',
  en: 'Thank you for calling. Have a good day.',
};

/**
 * Played when a turn is taking long enough that the line would otherwise go
 * quiet, while the real answer is still generating.
 *
 * Several variants per language on purpose. A caller who hears the identical
 * two words before every slow turn stops hearing a receptionist and starts
 * hearing a machine — and slow turns are exactly the ones that need the
 * caller's patience. They are rotated, never repeated back to back.
 *
 * Short by design: this has to fit inside the gap, not extend it.
 */
export const FILLERS: Record<Language, readonly string[]> = {
  mk: ['Само момент.', 'Да проверам.', 'Еден момент, ве молам.', 'Само да видам.'],
  sq: ['Vetëm një moment.', 'Po kontrolloj.', 'Një moment, ju lutem.', 'Sa ta shoh.'],
  en: ['One moment.', 'Let me check.', 'Just a second.', 'Let me have a look.'],
};

/** Every fixed line, for pre-synthesis. The greeting is added per business. */
export function cacheablePhrases(language: Language): string[] {
  return [
    ...DID_NOT_CATCH[language],
    CANNOT_HEAR[language],
    ...REPROMPTS[language],
    TRANSFER_UNAVAILABLE[language],
    CALLBACK_OFFER[language],
    FAREWELL[language],
    ...FILLERS[language],
  ];
}
