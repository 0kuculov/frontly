/**
 * The Frontly mark.
 *
 * A robot that answers the phone. The head is one filled shape with the face
 * knocked out of it, plus an antenna and two side tabs — solid blocks rather
 * than strokes, because the mark has to survive a 20px browser tab, and three
 * thin lines in a 20px square are a texture, not a symbol. The first version
 * of this file learned that the hard way with a handset arc.
 *
 * Drawn by hand, which is normally the wrong answer: icon glyphs come from a
 * library. A brand mark is the documented exception, and this one is five
 * primitives rather than a traced illustration, so it scales from that tab to
 * 200px on a projector without redrawing.
 *
 * `currentColor` throughout, so the mark inherits whatever it sits on: signal
 * blue in the nav, white on a dark panel, ink on paper. The knockouts read the
 * surface behind them from `--logo-knockout`, which is why one asset covers
 * every placement instead of a light and a dark variant drifting apart.
 */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const knockout = 'var(--logo-knockout, #fff)';
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
      {/* Antenna: the one detail that makes a rounded square read as a head. */}
      <circle cx="16" cy="3.1" r="2.3" fill="currentColor" />
      <rect x="14.9" y="4.4" width="2.2" height="4.2" fill="currentColor" />
      {/* Ear tabs, kept as blocks so they hold their shape when tiny. */}
      <rect x="0.5" y="14" width="3.4" height="6.4" rx="1.4" fill="currentColor" />
      <rect x="28.1" y="14" width="3.4" height="6.4" rx="1.4" fill="currentColor" />
      {/* The head. */}
      <rect x="3.4" y="7.6" width="25.2" height="21" rx="6.6" fill="currentColor" />
      {/* The face, knocked out. Equal eyes: a robot looks straight at you. */}
      <circle cx="11.6" cy="16.4" r="2.75" fill={knockout} />
      <circle cx="20.4" cy="16.4" r="2.75" fill={knockout} />
      <rect x="11" y="22" width="10" height="2.4" rx="1.2" fill={knockout} />
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
