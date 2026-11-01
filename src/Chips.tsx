import { useLayoutEffect, useRef, useState } from 'react'
import { CodeIcon, DocIcon, GlobeIcon, HistoryIcon, LayersIcon } from './icons'

/** The panes, in the chips' order. Keyed, like DEVICE_ICON, so a new one cannot compile
 *  without a name and a glyph. */
export const PANE = {
  preview: { label: 'Preview', Glyph: GlobeIcon },
  code: { label: 'Code', Glyph: CodeIcon },
  artefacts: { label: 'Artefacts', Glyph: DocIcon },
  history: { label: 'History', Glyph: HistoryIcon },
  more: { label: 'More', Glyph: LayersIcon },
} as const

export type Pane = keyof typeof PANE

export const PANES = Object.keys(PANE) as Pane[]

/** One duration and one curve for the pill and every label, which is what keeps the pill on
 *  its chip all the way — see Chips. */
const SLIDE = 'duration-250 ease-out motion-reduce:transition-none'

/**
 * The pane chips, as Lovable draws them: an icon each, and the name only on the one in
 * force, under a pill that slides to whichever is picked while the old name rolls up and
 * the new one unrolls.
 *
 * The pill is one element moved, not a background per chip, or it could only fade. Where
 * it goes is arithmetic, not a measurement of the chip it goes to: that chip's name has
 * only just started to unroll, so its box is the wrong one to aim at. Once the labels land,
 * every chip but the picked one is its bare width, so the picked one starts `i × (bare +
 * gap)` in and is `bare + its label` wide. The pill and every label go the same duration
 * along the same curve, so it lands on its chip as the names finish — never early to wait
 * for the chip, never late to chase it. On the way it is between the two, which is the
 * slide: measured at a tenth of the speed, its gap to the picked chip only ever closes.
 *
 * Only transitions on width and transform, which Safari has had for years; CSS anchor
 * positioning or `interpolate-size` would have saved the measuring, and are not there yet.
 */
export default function Chips({
  panes,
  tab,
  blink,
  onPick,
}: {
  panes: Pane[]
  tab: Pane | null
  /** A chip whose pane has news — the Preview's, when the first build lands behind another pane:
   *  its glyph blinks in the colour of the one in force, and only that colour where motion is
   *  reduced. */
  blink?: Pane | null
  onPick: (k: Pane) => void
}) {
  const group = useRef<HTMLDivElement>(null)
  /** In px: a chip without its label, the gap between chips, and each label's own width. */
  const [geo, setGeo] = useState<{ bare: number; gap: number; label: number[] } | null>(null)

  // Before paint, so the pill is drawn where it belongs the first time. The labels are what
  // can change size afterwards — the text steps up a size at md, and a web font could land
  // late — so they are what is watched.
  useLayoutEffect(() => {
    const el = group.current
    if (!el) return
    const chips = [...el.querySelectorAll<HTMLElement>(':scope > button')]
    const rolls = chips.map((c) => c.querySelector<HTMLElement>('[data-roll]')!)
    const labels = rolls.map((r) => r.firstElementChild as HTMLElement)
    const [a, b] = chips as [HTMLElement, HTMLElement]
    const box = (e: Element) => e.getBoundingClientRect()
    const measure = () =>
      setGeo({
        // Any chip less its roll, whatever width the roll is at right now.
        bare: box(a).width - box(rolls[0]!).width,
        gap: box(b).left - box(a).right,
        label: labels.map((l) => box(l).width),
      })
    measure()
    const ro = new ResizeObserver(measure)
    labels.forEach((l) => ro.observe(l))
    return () => ro.disconnect()
  }, [])

  // -1 when no pane is open, before the first build: then no chip is in force, and no pill.
  const at = tab ? panes.indexOf(tab) : -1
  return (
    <div
      ref={group}
      role="group"
      aria-label="pane"
      className="relative w-fit shrink-0 flex items-center gap-0.5 rounded-full border border-current/10 p-0.5"
    >
      {geo && at >= 0 && (
        <span
          aria-hidden
          className={`absolute inset-y-0.5 left-0.5 rounded-full bg-blue-500/15 ring-1 ring-inset ring-blue-500/35 transition-[transform,width] ${SLIDE}`}
          style={{ transform: `translateX(${at * (geo.bare + geo.gap)}px)`, width: geo.bare + (geo.label[at] ?? 0) }}
        />
      )}
      {panes.map((k, i) => {
        const on = k === tab
        const news = k === blink && !on
        const { label, Glyph } = PANE[k]
        return (
          <button
            key={k}
            onClick={() => onPick(k)}
            aria-pressed={on}
            title={label}
            // `relative`, or the pill — positioned, and so painted above anything in flow —
            // would cover the chip it sits under.
            className={`relative flex items-center rounded-full px-2 py-1.5 text-xs md:text-sm transition-[color,opacity] ${SLIDE} ${
              on || news ? 'text-blue-600 dark:text-blue-400' : 'opacity-60 hover:opacity-100'
            }`}
          >
            <Glyph className={`size-4 shrink-0 ${news ? 'animate-blink motion-reduce:animate-none' : ''}`} />
            {/* Always in the DOM, so it can be measured shut and is the button's name either
                way. Width, not display, so it can roll. `overflow-hidden` also lets a flex
                item go narrower than its text, which `width: 0` alone would not. Unmeasured,
                the one in force is its natural width, which is what it measures to. */}
            <span
              data-roll
              className={`overflow-hidden transition-[width] ${SLIDE}`}
              style={{ width: on ? geo?.label[i] : 0 }}
            >
              {/* The weight is the same shut or open, so the width measured shut is the one
                  it opens to. */}
              <span className="block w-max pl-1.5 font-medium">{label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

