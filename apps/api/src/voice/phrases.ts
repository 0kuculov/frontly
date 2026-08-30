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

/**
 * Words a caller uses to say "that is all", and nothing else.
 *
 * Two sets per language, and the split is the whole safety argument.
 * `CLOSING_STRONG` is a word that can only be ending the conversation —
 * "не", "благодарам", "довидување". `CLOSING_FILLER` is the connective tissue
 * those arrive wrapped in — "тоа", "е", "друго", "ви". An utterance closes the
 * call only when every one of its words is in one of the two sets AND at least
 * one is strong, which is an allowlist rather than a keyword search: "не,
 * сакам уште еден термин" contains a strong word and is still a request, so
 * the unknown word "сакам" sends it to the model where it belongs.
 *
 * Deliberately NOT a phrase list of whole sentences. Recognition returns
 * "Не ти благодарам", "Не, тоа е сè", "Благодарам, пријатно" and a dozen more
 * shapes of the same six words; matching the vocabulary covers all of them and
 * an exact-phrase list would cover three.
 */
const CLOSING_STRONG: Record<Language, readonly string[]> = {
  mk: ['не', 'ништо', 'благодарам', 'фала', 'довидување', 'пријатно', 'сè', 'здраво'],
  sq: ['jo', 'asgjë', 'faleminderit', 'mirupafshim', 'kaq', 'mjafton'],
  en: ['no', 'nope', 'nothing', 'thanks', 'thank', 'bye', 'goodbye', 'cheers'],
};

const CLOSING_FILLER: Record<Language, readonly string[]> = {
  mk: ['тоа', 'е', 'се', 'друго', 'повеќе', 'нема', 'ви', 'ти', 'многу', 'добро', 'ок', 'океј'],
  sq: ['tjetër', 'më', 'shumë', 'ju', 'të', 'ditën', 'mirë', 'e', 'është', 'po', 'ok', 'okej'],
  // 's' is what an apostrophe leaves behind: "that's all" splits to that, s, all.
  en: ['you', 'that', 'thats', 's', 'is', 'all', 'good', 'day', 'much', 'else', 'ok', 'okay', 'so'],
};

/** How many words an utterance may hold and still be only a goodbye. */
const CLOSING_MAX_WORDS = 6;

/**
 * Is this caller saying goodbye and nothing more?
 *
 * `\w` is defined over `[A-Za-z0-9_]` and matches no Cyrillic at all, so the
 * split is on "not a letter or a number" in Unicode terms instead. It also
 * folds the punctuation Azure adds, which is why "Не, тоа е сè." and
 * "не тоа е сè" are the same utterance here.
 */
export function isClosingCue(text: string, language: Language): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0 || words.length > CLOSING_MAX_WORDS) return false;

  const strong = CLOSING_STRONG[language];
  const filler = CLOSING_FILLER[language];
  let sawStrong = false;
  for (const word of words) {
    if (strong.includes(word)) {
      sawStrong = true;
      continue;
    }
    if (!filler.includes(word)) return false;
  }
  return sawStrong;
}
