/**
 * The Frontly mark: a heavy geometric F, reproduced from the supplied
 * reference.
 *
 * Built from two STROKED paths rather than one traced outline, and that is the
 * whole trick. The reference's character is a constant-weight bar that turns a
 * large radius on the left and stops square on the right; a stroke with
 * `linejoin: round` and `linecap: butt` produces exactly that by construction,
 * so the curve stays a true constant width at every size instead of drifting
 * the way a hand-computed outline does. It also means the weight is one
 * number, not forty coordinates.
 *
 * The reading, so the mark can be redrawn rather than copied:
 *  - The top arm sweeps out of the stem on a radius roughly the bar's own
 *    height, which is what gives the mark its forward lean without any italic.
 *  - Both arms end SQUARE on the right. Rounding them too would make it a
 *    generic soft logo; the contrast between the curved left and the cut right
 *    is the whole silhouette.
 *  - The foot is angled, because the last stem segment leans and a butt cap is
 *    perpendicular to its own direction.
 *
 * TWO VARIANTS, because the brief asked for one if legibility failed small.
 * It does: below about 32px the counter between the arms closes up and the
 * mark starts reading as a filled blob. `SMALL` opens the gap, thickens the
 * bar slightly and shortens the sweep, which holds at 16px in a browser tab.
 * Verified by rendering both at 16/20/24/32/48/140.
 *
 * `currentColor` throughout, so one asset serves every placement: azure in the
 * dashboard header, paper on the indigo sidebar, ink on white. Monochrome by
 * construction — there is no gradient version, because a mark that needs one
 * is not a mark.
 */

/** Above 32px: the reference's own proportions. */
const FULL = {
  width: 22,
  arm: 'M86 25 H47 Q31 25 31 44 L36 90',
  bar: 'M31 70 Q31 56 46 56 H79',
};

/** At or below 32px: wider counter, heavier bar, shorter sweep. */
const SMALL = {
  width: 23,
  arm: 'M86 24 H46 Q31 24 31 42 L35 88',
  bar: 'M31 74 Q31 59 46 59 H76',
};

/** Below this the full drawing's counter closes up. Measured, not guessed. */
const SMALL_BELOW = 32;

export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const shape = size <= SMALL_BELOW ? SMALL : FULL;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <g
        stroke="currentColor"
        strokeWidth={shape.width}
        strokeLinecap="butt"
        strokeLinejoin="round"
      >
        <path d={shape.arm} />
        <path d={shape.bar} />
      </g>
    </svg>
  );
}

/**
 * The lockup: the F glyph, then "rontly".
 *
 * The mark IS the F — "rontly" completes the word rather than sitting beside
 * it — so a gap turns "Frontly" into "F rontly". The glyph carries its own
 * side bearing inside a 100-unit box, so the negative pull closes that empty
 * space rather than guessing at a letter-space, and it is in `em` because the
 * lockup runs at 20px in a footer and 26px in a nav.
 */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Logo size={size} title="Frontly" />
      <span aria-hidden>rontly</span>
    </span>
  );
}
