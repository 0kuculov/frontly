/**
 * The Frontly mark, reproduced from the supplied reference.
 *
 * TWO HOOKS, not one letter. That is the reading the first attempt got wrong:
 * this is not an F with a crossbar, it is a large hook and a smaller one nested
 * inside it, separated by an even white channel. Each hook is a thick
 * horizontal bar whose left end sweeps down into a descender — the top one
 * TAPERS TO A POINT (the thin crescent on the left flank), the bottom one keeps
 * its full width and lands flat.
 *
 * Filled paths rather than strokes, because a stroke cannot taper. The first
 * build used two stroked paths, which held a constant width beautifully and
 * therefore could not produce the one feature that gives this mark its
 * character.
 *
 * Proportions were measured off the reference rather than judged: the glyph is
 * 110 × 100, the top bar reaches the full width, the middle bar stops at 82,
 * the stem is 32 wide, and the channel between the hooks holds about 3 units
 * all the way round its curve.
 *
 * TWO VARIANTS. Below 32px the channel closes and the mark reads as a blob, so
 * `SMALL` widens it, blunts the taper and shortens the sweep — verified legible
 * down to 14px, on paper and on indigo. `size` is the HEIGHT; width follows the
 * 1.1 aspect, because forcing this into a square would squash it.
 *
 * `currentColor` throughout, so one asset covers every placement.
 */

/** Above 32px: the reference's own proportions, fine taper and all. */
const FULL =
  'M110 0 L36 0 C15 0 0 16 0 38 L6 67 C9 48 15 40 27 35 L95 33 Z ' +
  'M47 37 L65 37 C74 37 82 45 82 53 C82 61 74 69 65 69 L42 69 L42 100 ' +
  'L10 100 L10 70 C10 51 26 37 47 37 Z';

/** At or below 32px: wider channel, blunter taper. */
const SMALL =
  'M110 0 L38 0 C17 0 2 17 2 40 L11 63 C14 50 20 43 31 39 L93 36 Z ' +
  'M50 43 L64 43 C73 43 80 50 80 58 C80 66 73 73 64 73 L45 73 L45 100 ' +
  'L13 100 L13 72 C13 55 29 43 50 43 Z';

/** Below this the full drawing's channel closes up. Measured, not guessed. */
const SMALL_AT_OR_BELOW = 32;

export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size * 1.1}
      height={size}
      viewBox="0 0 110 100"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path
        d={size <= SMALL_AT_OR_BELOW ? SMALL : FULL}
        fillRule="evenodd"
      />
    </svg>
  );
}

/**
 * The lockup: the F glyph, then "rontly".
 *
 * The mark IS the F — "rontly" completes the word rather than sitting beside
 * it — so a gap turns "Frontly" into "F rontly". The pull is in `em` because
 * the lockup runs at 20px in a footer and 26px in a nav, and a fixed value
 * would open a gap at one size and overlap at the other.
 */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Logo size={size} title="Frontly" />
      <span aria-hidden>rontly</span>
    </span>
  );
}
