/**
 * A design's colours as one strip — canvas, surface, ink, primary, accent, as the catalog
 * orders them (scripts/design-catalog.ts). Decoration beside the design's name and blurb,
 * which say what it is in words, so it is hidden from a screen reader; the title lists the
 * values for a pointer that wants them.
 *
 * Framed and divided by a pixel of the text's colour, showing through the gaps: a ring alone
 * let a near-black ink vanish into the dark theme's card, and the strip read as having a hole
 * (Claude's, 390 dark, 2026-09-27). The same pixel is dark on a light card, where a white
 * canvas would vanish instead.
 */
export default function Swatches({ colors, className = '' }: { colors: readonly string[]; className?: string }) {
  return (
    <span
      aria-hidden="true"
      title={colors.join(' · ')}
      className={`flex h-5 w-28 shrink-0 gap-px overflow-hidden rounded-md bg-current/25 p-px ${className}`}
    >
      {colors.map((c, i) => (
        <span key={i} className="flex-1 first:rounded-l-[5px] last:rounded-r-[5px]" style={{ background: c }} />
      ))}
    </span>
  )
}
