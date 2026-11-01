import { memo, useCallback, useLayoutEffect, useRef } from 'react'
import { useDisclosure } from './hooks'
import { ChevronIcon } from './icons'
import { type Pin, hold, repin } from './pin'
import { opening, sizeOf, tail } from './thoughts'

/**
 * One step's reasoning, as a bubble in its place in the turn: after what the step before it
 * did, before what this step says and does (Chat draws the turn's `flow`).
 *
 * GLM reasons for minutes before it says a word — 26,683 characters in one 85 s step,
 * measured 2026-09-23 — and the bubble used to show only the last three lines of it while
 * it happened, then nothing at all. Then one card held every step behind a line counting
 * them, then a stack of them at the turn's foot, apart from the rows each led to; the
 * person found both confusing (specs/chat-improvement, 2026-10-06). Labelled "thinking", so
 * it reads as the model's reasoning and not something it said.
 *
 * One component from its first thought through the end of the turn and after it, so the
 * open state and the scroll position carry across "thinking", "writing" and "done" with
 * nothing handed over. Closed, the button is either the three-line tail box, while the
 * model is reasoning in this step, or one line: the step's opening words and its size. Open,
 * that line is the header and the step sits under it.
 *
 * A button and a region rather than a <details>, though it looks like Note: the tail box
 * itself has to be the toggle, and it needs a name that holds still while its text moves
 * four times a second. So while it is the live step its name is "thinking", open or closed,
 * since its size moves as often as the tail does, and the line joins the name once, when
 * the turn goes on past it or ends. Only the button closes it, or Escape from inside the
 * panel, which hands the focus back to the button. A tap on the text to stop a fling, or a
 * long-press to select some, would otherwise shut the panel under the reader.
 */
function Thinking({
  text,
  live,
  thinking,
  settle,
}: {
  /** The step, raw. */
  text: string
  /** The turn streams, and this is the newest thing in it. */
  live: boolean
  /** The model is reasoning in this step right now. */
  thinking: boolean
  /** The chat's: re-reads whether it is at its bottom once this has grown under it. */
  settle: () => void
}) {
  const region = useRef<HTMLDivElement>(null)
  const pin = useRef<Pin>({ stuck: false, top: 0 })
  // Brought into view as it opens (useDisclosure). A live step's `settle` is the chat's own
  // `following`, which takes it to its bottom: under the live step sit the activity line, and
  // the plan once its question is in, which no margin here can count on (review of #46).
  const { open, wrapProps, buttonProps, regionProps } = useDisclosure(settle, () => {
    // A live panel opens at the newest text and follows it; a finished step's opens at its top.
    pin.current = { stuck: live, top: 0 }
  })
  const tailMode = thinking && !open

  // Before paint, so a pinned panel never shows a frame of itself one send behind.
  useLayoutEffect(() => {
    const r = region.current
    if (r && open && live) hold(pin.current, r)
  }, [open, live, text])

  // And when the panel itself changes height, which on a short screen it does without a
  // send: its cap follows the chat's height (see the region), and the chat gets 33 px
  // shorter when the usage line arrives with `done`. That left a panel the reader had kept
  // open to the end as far above its last line (844x390). Only while it follows; a reader
  // who has scrolled the panel up is not moved.
  useLayoutEffect(() => {
    const r = region.current
    if (!r || !open) return
    const ro = new ResizeObserver(() => {
      if (pin.current.stuck) hold(pin.current, r)
    })
    ro.observe(r)
    return () => ro.disconnect()
  }, [open])

  // A finished step's panel opens at its top every time, not only the first. Chrome keeps the
  // scroll offset of an element hidden with display:none and restores it when the element
  // is shown again, and emptying the region does not clamp that offset, because a hidden
  // box is never laid out: a panel closed at 300 px reopened at 300 px (measured
  // 2026-09-24, 390 px wide). On [open] alone, so the end of a turn does not send a reader
  // who kept its panel open back to the top. `stuck` is false exactly when the panel was
  // not live as it opened — toggle() just set it, and no scroll event reaches a hidden
  // region. Writing scrollTop forces layout, which is when the browser restores the old
  // offset, so this write lands after it and wins.
  useLayoutEffect(() => {
    const r = region.current
    if (r && open && !pin.current.stuck) r.scrollTop = 0
  }, [open])

  // The tail box's top edge is masked only when the box is actually clipping, which is what
  // hides the 2–3 px sliver of a cut-off line seen on the Mac without half-fading a thought
  // that fits. The child is measured, not the box's scrollHeight: overflow at the start edge
  // of a `justify-end` box is not scrollable overflow, so the box reports none. An attribute
  // rather than state, so there is no second render four times a second, and the observer
  // runs before paint, so the mask lands in the same frame as the line that needs it.
  const clip = useCallback((inner: HTMLSpanElement | null) => {
    const box = inner?.parentElement
    if (!inner || !box) return
    const ro = new ResizeObserver(() =>
      box.toggleAttribute('data-clipped', inner.getBoundingClientRect().height > box.getBoundingClientRect().height + 0.5),
    )
    ro.observe(inner)
    return () => ro.disconnect()
  }, [])

  return (
    <div {...wrapProps} data-thinking className="scroll-mb-8 overflow-hidden rounded-xl border border-current/10 whitespace-normal text-sm">
      <button
        {...buttonProps}
        className={`flex w-full select-none gap-2 px-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current/40 ${
          tailMode
            ? 'items-end pb-2.5 pt-2.5 active:bg-current/10'
            : 'items-center py-3 opacity-60 hover:opacity-100'
        }`}
      >
        {/* While the step runs its size moves with every send, three or four times a second
            for the first 10k characters, and a screen reader speaks a name change of the
            focused control (NVDA does), so until it is done the name is just this. */}
        <span className="sr-only">
          thinking
          {!live && ': '}
        </span>
        <span
          aria-hidden
          className={`shrink-0 rounded-full bg-current/10 px-2 py-0.5 text-xs not-italic ${tailMode ? 'self-start' : ''}`}
        >
          {/* Only while it reasons: a step that has stopped and is writing a file it sends
              in one piece (12–19 s on GLM), or saving, is not thinking (review of #46). */}
          {thinking ? 'thinking…' : 'thinking'}
        </span>
        {tailMode ? (
          <>
            {/* Bottom-aligned in a box at most three lines tall: flex-end overflows at the
                top, so the newest words stay in view and the oldest leave over the top
                edge, a whole line at a time. The top 0.25lh of the mask is fully clear. */}
            <span
              aria-hidden
              data-tail
              className="flex max-h-[3lh] min-w-0 flex-1 flex-col justify-end overflow-hidden italic opacity-50 data-clipped:[mask-image:linear-gradient(to_bottom,transparent_0.25lh,#000_1lh)]"
            >
              <span ref={clip} className="wrap-anywhere">
                {tail(text)}
              </span>
            </span>
          </>
        ) : (
          <span aria-hidden={live || undefined} className="flex min-w-0 flex-1 gap-3">
            <span className="min-w-0 flex-1 truncate">{opening(text)}</span>
            <span className="shrink-0 tabular-nums">
              <span className="sr-only">, </span>
              {sizeOf(text)} chars
            </span>
          </span>
        )}
        <ChevronIcon
          className={`size-3.5 shrink-0 opacity-50 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {/* Always in the DOM, so aria-controls always points at something; its children only
          while open, so a closed past turn lays out none of its reasoning. Upright and at
          75%, not the tail's italic 50%: tens of thousands of characters have to be read.
          At most half the screen, and never so tall that the block and its scroll-mb-8
          outgrow the chat, or opening it reveals its top (above). `100cqh` is the chat's
          content box, 24 px of padding short of its height (Chat.tsx makes it the size
          container), so the 44 px header, the card's 2 px of border, the 32 px margin and,
          under a live step, the activity line and its 12 px gap, 32 px, leave 86 px to take
          off (49 while it was 12 px text inside the bubble, 54 without the line). It
          binds exactly where the block did not fit, on a screen under about 550 px tall at
          md, 615 while the usage line or the workspace's error line takes 33 px more: at
          844x390 the chat was 215 px and the block 236, and opening the live panel left the
          chat 38 px from its bottom and unpinned, with the newest lines under the fold.
          Never under two lines (3.25rem with the padding), since a panel that shows none is
          no panel, which is also where it stops fitting: below a 130 px chat the block
          opens from its top, as it did before. */}
      <div
        {...regionProps}
        ref={region}
        tabIndex={0}
        onScroll={(e) => repin(pin.current, e.currentTarget)}
        className="max-h-[max(3.25rem,min(50dvh,32rem,100cqh-86px))] overflow-y-auto overscroll-contain px-3 pb-3 leading-5 opacity-75 wrap-anywhere"
      >
        {open && (
          <div className="space-y-2">
            {text
              .trim()
              .split(/\n\s*\n/)
              .map((p, i) => (
                <p key={i} className="whitespace-pre-wrap">
                  {p}
                </p>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(Thinking)
