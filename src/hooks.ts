/**
 * The hooks more than one component had written out for itself: the chat store, a read that
 * only its latest answer may land from, a button's action, and a panel that opens in the chat.
 */
import { type DependencyList, type KeyboardEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type State, get, subscribe } from './chatStore'

const whole = (s: State) => s

/**
 * A project's chat state (chatStore), or the part of it `pick` reads: the component redraws
 * when that changes. Pick a part where the state's churn would cost — it is new with every
 * `thought`, four times a second.
 */
export function useChat<T = State>(slug: string, pick: (s: State) => T = whole as (s: State) => T): T {
  return useSyncExternalStore(
    useCallback((notify: () => void) => subscribe(slug, notify), [slug]),
    () => pick(get(slug)),
  )
}

/**
 * Runs `read` whenever `deps` change, and hands its answer to `then`, or why it failed to
 * `fail`, unless the deps moved on or the component went first: an older answer landing after a
 * newer one would show what is no longer there. `read` may return nothing, to skip.
 */
export function useLatest<T>(
  read: () => Promise<T> | undefined,
  deps: DependencyList,
  then: (v: T) => void,
  fail: (e: Error) => void = () => {},
): void {
  useEffect(() => {
    let live = true
    read()?.then(
      (v) => live && then(v),
      (e: Error) => live && fail(e),
    )
    return () => {
      live = false
    }
  }, deps)
}

/**
 * A button's action: `going` while it runs, so a second tap cannot send it twice (it answered
 * 409 under the first), and `error` once it fails. `then` takes what it answered.
 */
export function useRun<T>(then: (v: T) => void) {
  const [going, setGoing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (task: () => Promise<T>) => {
    setGoing(true)
    setError(null)
    task()
      .then(then)
      .catch((x: Error) => setError(x.message))
      .finally(() => setGoing(false))
  }
  return { going, error, run }
}

/**
 * A button that opens a region under itself, in the chat: a reasoning step (Thinking) or what a
 * write changed (WriteRow). Escape from inside closes it and hands the focus back to the button.
 * `onOpen` runs as it opens; `grown` is whatever makes it taller while open.
 *
 * Opening grows the chat without a scroll, often past the fold, so the block is brought into
 * view — on a tap, while the chat is the pane on screen, so the phone's snap strip cannot move —
 * and the chat's `settle` re-reads its pin: the panel may have opened in a turn above the
 * bottom and left the reader there, and without a scroll up the direction rule would still take
 * them for following. The block's `scroll-mb-8` is what lets a reveal in the last turn reach the
 * chat's real bottom: 'nearest' stops at the block's edge, under which sit the scroller's 12 px
 * of padding. And the block has to fit in the chat for 'nearest' to reach that bottom at all; of
 * a taller one it shows the top (see Thinking's cap).
 */
export function useDisclosure(settle: () => void, onOpen?: () => void, grown?: unknown) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  const toggle = () => {
    if (!open) onOpen?.()
    setOpen(!open)
  }

  useLayoutEffect(() => {
    if (!open) return
    // Braces are load-bearing: as of Chrome 153 scrollIntoView() returns a Promise, and a
    // concise body would hand it to React as the effect's cleanup, which unmounted the
    // whole tree to a white page once (the scrollIntoView trap in the private design log).
    wrap.current?.scrollIntoView({ block: 'nearest' })
    settle()
  }, [open, settle, grown])

  return {
    open,
    toggle,
    wrapProps: {
      ref: wrap,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Escape' && open) {
          toggle()
          button.current?.focus()
        }
      },
    },
    buttonProps: {
      ref: button,
      id: `${id}b`,
      type: 'button' as const,
      'aria-expanded': open,
      'aria-controls': `${id}r`,
      onClick: toggle,
    },
    regionProps: { id: `${id}r`, role: 'region', 'aria-labelledby': `${id}b`, hidden: !open },
  }
}
