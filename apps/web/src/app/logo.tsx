/**
 * The Frontly mark.
 *
 * A speech bubble whose tail is also a handset. The product is one idea, a
 * conversation that answers a phone, and the mark is the same two things
 * sharing one outline rather than a phone glyph with a chat bubble bolted
 * beside it.
 *
 * Drawn by hand, which is normally the wrong answer: icon glyphs come from a
 * library. A brand mark is the documented exception, and this one is four
 * primitives (a rounded rect, a notch, two dots and an arc) rather than a
 * traced illustration, so it stays legible at 20px in a browser tab and at
 * 200px on a projector.
 *
 * `currentColor` throughout, so the mark inherits whatever it sits on: signal
 * blue in the nav, white on the dark hero panel, ink on paper. One asset, no
 * variants to keep in sync.
 */
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
      {/*
        The bubble, filled rather than outlined.

        The first version drew a handset arc inside an outlined bubble and it
        was mush at 24px in the nav: three thin strokes competing inside a
        28-pixel square. A mark has to survive a browser tab, so this one is
        two shapes and nothing else.
      */}
      <path
        d="M6 3h20a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H13l-7 5.5V23H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"
        fill="currentColor"
      />
      {/*
        Two voices, knocked out of the bubble. Unequal on purpose: the larger
        one answers, and two identical dots would read as the generic
        typing-indicator icon every chat product already uses.
      */}
      <circle cx="12" cy="13" r="2.6" fill="var(--logo-knockout, #fff)" />
      <circle cx="21" cy="13" r="1.7" fill="var(--logo-knockout, #fff)" />
    </svg>
  );
}

/** The mark plus the name, which is how it appears everywhere except a tab. */
export function Wordmark({ size = 26 }: { size?: number }) {
  return (
    <span className="wordmark">
      <Logo size={size} title="Frontly" />
      <span>Frontly</span>
    </span>
  );
}
