import { useLayoutEffect, useRef, useState } from 'react'

/** The chat's width when nobody has dragged it: a third of the window, within bounds. */
export const CHAT_DEFAULT = 'clamp(24rem, 32vw, 38rem)'
/** A dragged width is still clamped, by CSS at every render, so a window made smaller
 *  later can never leave the preview under 22rem or the chat under 20rem. */
export const chatWidth = (px: number) => `clamp(20rem, ${px}px, 100vw - 22rem)`
/** chatWidth's bounds in px, from the root's font size rather than 16: under a larger
 *  browser font a rem is 20 px or more, and bounds written as 320 and 352 kept numbers the
 *  screen never showed. */
function chatBounds(): { min: number; max: number } {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
  return { min: 20 * rem, max: window.innerWidth - 22 * rem }
}
/** In clamp()'s order, so where the window is too narrow for both the minimum wins, as it
 *  does in CSS. */
function clampChat(px: number): number {
  const { min, max } = chatBounds()
  return Math.round(Math.max(min, Math.min(max, px)))
}
const CHAT_KEY = 'ab-chat-width'

/** Per browser, like the theme: a width suits a screen, not a project. */
export function storedWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(CHAT_KEY))
    return v > 0 ? v : null
  } catch {
    return null
  }
}

function storeWidth(px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(CHAT_KEY)
    else localStorage.setItem(CHAT_KEY, String(px))
  } catch {
    // The width still holds for this page; it just will not outlive it.
  }
}

/**
 * The chat's right edge, as a handle: drag it, or focus it and use the arrow keys;
 * double-click or Enter puts the default back. md and up only — below that each pane is
 * the whole screen. 12 px wide, findable without a line of its own until hovered, and
 * all of it on the preview's side of the border, over the 16 px of padding every pane
 * there has: straddling the border, it took the last 6 px of the chat's scrollbars, and
 * grabbing a thumb there resized the chat instead of scrolling it.
 */
export default function ChatEdge({
  width,
  onWidth,
  onDrag,
}: {
  width: number | null
  onWidth: (px: number | null) => void
  onDrag: (dragging: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const from = useRef<{ x: number; w: number; moved: boolean } | null>(null)
  /** The last width set, for storing on release: a move's render may not have landed yet. */
  const last = useRef(width)
  /** What a screen reader is told: the width on screen, which is not `width` when that is
   *  null or wider than the window allows, and the bounds in px at this window's size. */
  const [aria, setAria] = useState<{ now: number; min: number; max: number } | null>(null)
  const chat = (el: HTMLElement) => el.parentElement?.getBoundingClientRect().width ?? 0
  // The chat's box and the window's: the chat can change width without the window (a
  // drag), and the bounds can change without the chat (a window already at a bound).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el?.parentElement) return
    const ro = new ResizeObserver(() => {
      const { min, max } = chatBounds()
      setAria({ now: Math.round(chat(el)), min: Math.round(min), max: Math.round(max) })
    })
    ro.observe(el.parentElement)
    ro.observe(document.documentElement)
    return () => ro.disconnect()
  }, [])
  // The same bounds the CSS clamp applies, so the number kept is the width shown.
  const put = (px: number | null, store = false) => {
    last.current = px === null ? null : clampChat(px)
    onWidth(last.current)
    if (store) storeWidth(last.current)
  }
  const end = () => {
    if (!from.current) return
    from.current = null
    onDrag(false)
    storeWidth(last.current)
  }
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label="resize the chat"
      aria-controls="ab-chat"
      aria-valuenow={aria?.now}
      aria-valuemin={aria?.min}
      aria-valuemax={aria?.max}
      aria-valuetext={aria ? `${aria.now} px` : undefined}
      tabIndex={0}
      title="drag to resize · double-click to reset"
      className="group absolute inset-y-0 -right-3 z-10 hidden w-3 cursor-col-resize touch-none md:block focus-visible:outline-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        from.current = { x: e.clientX, w: chat(e.currentTarget), moved: false }
        onDrag(true)
      }}
      onPointerMove={(e) => {
        const f = from.current
        if (!f) return
        // A press is not a drag until it has gone 3 px sideways. Every move used to set the
        // width, so a click with a pixel of jitter, even straight down, stored the width it
        // was at: the default stopped following the window, and a wider width kept for a
        // wider window was cut to this one's.
        if (Math.abs(e.clientX - f.x) >= 3) f.moved = true
        if (f.moved) put(f.w + e.clientX - f.x)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => put(null, true)}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowLeft' ? -32 : e.key === 'ArrowRight' ? 32 : 0
        if (step) {
          e.preventDefault()
          // From the width shown, and only if the step shows: at a bound a key moves
          // nothing, and storing the clamped width would cut a wider one kept for a wider
          // window down to this one's.
          const w = Math.round(chat(e.currentTarget))
          if (clampChat(w + step) !== w) put(w + step, true)
        } else if (e.key === 'Enter') put(null, true)
      }}
    >
      <div className="h-full w-0.5 rounded-full transition-colors group-hover:bg-current/25 group-focus-visible:bg-current/40 group-active:bg-current/40" />
    </div>
  )
}
