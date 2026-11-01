import { MoonIcon, SunIcon, SystemIcon } from './icons'
import { set, useTheme, type Theme } from './theme'
import { GROUP, OFF, ON } from './ui'

/** Keyed by setting, so adding a fourth to Theme cannot compile without a glyph — the
 *  same guard DEVICE_ICON gives the form-factor group it is modelled on. */
const GLYPH: Record<Theme, typeof SunIcon> = {
  light: SunIcon,
  dark: MoonIcon,
  system: SystemIcon,
}

const ORDER: Theme[] = ['light', 'dark', 'system']

/**
 * The theme switcher, on all three screens: it is a property of the app rather than of
 * any one of them, and the screen you want to judge a palette on is whichever one you
 * are looking at — most often the code pane.
 *
 * A segmented group rather than one button that cycles, for the reason the form-factor
 * group is one: three alternatives where the one in force is readable without touching
 * anything. A cycling button would have to say "system" and "dark" with the same glyph
 * whenever the system is dark, which is most of the time this control gets used.
 *
 * `className` carries the layout, because GROUP deliberately has no display utility —
 * see ui.ts. Callers pass `flex`; where it hides, a parent hides it.
 */
export default function ThemeToggle({ className }: { className: string }) {
  const { theme, resolved } = useTheme()

  return (
    <div role="group" aria-label="theme" className={`${className} ${GROUP}`}>
      {ORDER.map((t) => {
        const Glyph = GLYPH[t]
        return (
          <button
            key={t}
            onClick={() => set(t)}
            aria-pressed={t === theme}
            // aria-label carries the word the glyph replaces. title says what the setting
            // means, and for `system` what it currently resolves to — the one thing the
            // half-filled circle cannot say, and the only way to tell a deliberate `dark`
            // from a `system` that happens to be dark right now.
            aria-label={t}
            title={t === 'system' ? `follow the system — currently ${resolved}` : `always ${t}`}
            className={`rounded-md p-1.5 ${t === theme ? ON : OFF}`}
          >
            <Glyph className="size-4" />
          </button>
        )
      })}
    </div>
  )
}
