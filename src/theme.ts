import { useSyncExternalStore } from 'react'

/**
 * Which of the two palettes in app.css is painted, and who decides.
 *
 * The setting has three values and the page has two, so something has to resolve one to
 * the other. It happens here rather than in CSS: a `prefers-color-scheme` query would
 * answer the OS's question, and once there is a switcher the OS is only one of three
 * possible answers. This module writes `data-theme="light"` or `"dark"` on <html> and
 * keeps writing it — on a switch, on an OS change while the setting is `system`, and on
 * the same change made in another tab.
 *
 * The first paint is not ours: index.html carries a copy of the two lines that matter,
 * because this module arrives with the bundle and a page that renders before it has
 * already flashed the wrong palette. Everything below still runs — applying on load is
 * what makes this module correct on its own and that script purely an optimisation.
 */
export type Theme = 'light' | 'dark' | 'system'
type Resolved = 'light' | 'dark'

/** Shared with the inline script in index.html. Changing it here changes it there. */
const KEY = 'ab-theme'

/**
 * `system` is the absence of the key, not a third stored value. That makes following
 * the OS the state a browser that has never been told anything is already in, and it
 * keeps the boot script down to two string comparisons.
 */
function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    // Storage can throw outright rather than return null — a third-party-cookie policy
    // strict enough to deny it applies to this origin too, and a theme is not worth a
    // white screen.
    return 'system'
  }
}

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)')

let theme: Theme = stored()
let applied: Resolved = theme === 'system' ? (prefersDark.matches ? 'dark' : 'light') : theme

/**
 * Setting and resolution in one string, because `useSyncExternalStore` compares
 * snapshots by identity: an object would be a new one every read and re-render forever,
 * while the setting alone would not change when the OS moves under `system` — and
 * `system`'s own label says which palette that currently means.
 */
function snapshot(): string {
  return `${theme} ${applied}`
}

const listeners = new Set<() => void>()

function apply(): void {
  applied = theme === 'system' ? (prefersDark.matches ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = applied
  listeners.forEach((notify) => notify())
}

export function subscribe(notify: () => void): () => void {
  listeners.add(notify)
  return () => {
    listeners.delete(notify)
  }
}

export function set(next: Theme): void {
  theme = next
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // Same as reading: the switch still works for this page, it just will not outlive it.
  }
  apply()
}

/** Only observable while the setting is `system`, but apply() is two writes — cheaper
 *  than the branch that would skip it, and it cannot fall out of step. */
prefersDark.addEventListener('change', apply)

/** The workspace and the project list are frequently two tabs of the same work, and a
 *  switch in one that leaves the other on the old palette is the kind of half-applied
 *  preference people re-click until both agree. `key` is null when storage is cleared. */
window.addEventListener('storage', (e) => {
  if (e.key !== KEY && e.key !== null) return
  theme = stored()
  apply()
})

apply()

/**
 * Wrapped rather than called at the three sites, so the snapshot's encoding stays in
 * this file — a component splitting that string is a component that can be given an
 * object instead and quietly re-render forever.
 */
export function useTheme(): { theme: Theme; resolved: Resolved } {
  const [setting, resolvedTheme] = useSyncExternalStore(subscribe, snapshot).split(' ')
  return { theme: setting as Theme, resolved: resolvedTheme as Resolved }
}
