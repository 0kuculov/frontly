/**
 * The Frontly mark: an F that answers.
 *
 * Built as ONE closed path, not a set of strokes. This file has already
 * learned that lesson twice — an outlined bubble with a handset arc was mush
 * at 24px, and three thin lines in a small square are a texture rather than a
 * symbol. A single solid mass survives a browser tab.
 *
 * The construction, so it can be redrawn rather than traced:
 *
 *   - A geometric F, leaned 6° from a pivot on the baseline. Six degrees, not
 *     the twelve of a display italic: the product answers a phone instantly,
 *     which is composure, not racing. A steeper lean puts it straight back
 *     into the logistics-and-fintech silhouette this was drawn to avoid.
 *   - The MIDDLE arm runs longer than the top one and ends in a wedge whose
 *     tip drops to the lower right — the tail of a speech bubble, and the only
 *     thing in the mark that is not a rectangle. Read fast it is an F; read
 *     once more, something in it spoke.
 *   - The foot is cut flat. Logistics marks trail backwards into speed lines
 *     because they are about travel. This one arrives and stops.
 *
 * `currentColor` throughout, so one asset covers every placement: cobalt in
 * the nav, paper on a dark panel, ink on white. Monochrome by construction —
 * there is no gradient version, because a mark that needs one is not a mark.
 */

/** The single path, leaned and balanced inside a 32-unit box. */
const F_PATH =
  'M8.5 4 L25 4 L24.4 9.6 L13.9 9.6 L13.5 14.2 L25 14.2 L24.4 19.8 L22.8 24.8 L20.6 19.8 L12.9 19.8 L12 28 L6 28 Z';

export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={F_PATH} fill="currentColor" />
    </svg>
  );
}

/**
 * The lockup: the F glyph, then "rontly".
 *
 * The word is set in the product's own text face rather than drawn, which is
 * the whole point of a wordmark built this way — it renders in Cyrillic
 * contexts, it stays crisp at any size, and there is no second asset to keep
 * in sync. The F carries the identity; the word only has to belong to it.
 *
 * The negative margin closes the gap the glyph's own side bearing opens up:
 * the path stops at x=27 inside a 32-unit box, so without it the F and the
 * "r" read as two words.
 */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Logo size={size} title="Frontly" />
      <span aria-hidden>rontly</span>
    </span>
  );
}
