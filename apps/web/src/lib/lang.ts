/**
 * Which languages the dashboard speaks.
 *
 * Its own module, and the reason is a build error rather than tidiness: this
 * used to live in `session.ts`, which imports `next/headers` to read cookies.
 * A client component importing the LIST of languages therefore pulled a
 * server-only module into the browser bundle and the build refused. Types are
 * erased and cross that line for free; a runtime array does not.
 *
 * `session.ts` re-exports both, so nothing that already imported them had to
 * change.
 */

export type Lang = 'mk' | 'sq' | 'en';

/** The same three the phone line speaks, in the same order of precedence. */
export const LANGS: readonly Lang[] = ['mk', 'sq', 'en'];

/** Anything unrecognised is Macedonian: this parses a cookie, not a promise. */
export function toLang(value: string | undefined): Lang {
  return LANGS.includes(value as Lang) ? (value as Lang) : 'mk';
}
