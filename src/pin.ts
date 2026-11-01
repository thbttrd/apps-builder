/**
 * Whether a scroller follows its newest content: the chat, and an open reasoning panel.
 *
 * By direction, not by distance. Any scroll up by the reader unpins at once. Our own writes
 * to the bottom go through hold(), which records where each one put the scroller, so they
 * never read as the reader moving, and a move up that lands in the same frame as one still
 * reads as a move up. A distance threshold cannot tell the two apart: a reader who has moved up by
 * less than its slack stays pinned, and the next send, four times a second while the model
 * reasons, pulls them back down. Reaching the bottom again, by hand or by a collapse that
 * clamps `scrollTop`, re-pins.
 *
 * 2 px of slack, because `scrollTop` is fractional at a device pixel ratio of 2 or 3 and
 * the bottom is rarely exactly 0 away. No imports, so the check suite drives it directly.
 */
export type Pin = { stuck: boolean; top: number }

type Box = { scrollTop: number; scrollHeight: number; clientHeight: number }

const atBottom = (el: Box) => el.scrollHeight - el.scrollTop - el.clientHeight <= 2

/** For `onScroll`. */
export function repin(pin: Pin, el: Box): void {
  pin.stuck = atBottom(el) || (pin.stuck && el.scrollTop >= pin.top)
  pin.top = el.scrollTop
}

/**
 * For our own writes: to the bottom, if the reader is following. A browser fires at most
 * one scroll event a frame, and Chrome applies a wheel delta that reaches it in the same
 * frame as this write on top of the write, so that one event has to compare the reader's
 * position with where this put the scroller, not with where the last event saw it.
 * Headless Chrome 1243: a 20 px wheel up against a 40 px growth write left the scroller
 * 20 px up and still pinned in 50 of 60 runs before this, and in 0 of 60 after. The repin
 * first also catches a move up that the browser has applied but not yet reported.
 */
export function hold(pin: Pin, el: Box): void {
  repin(pin, el)
  if (!pin.stuck) return
  el.scrollTop = el.scrollHeight
  pin.top = el.scrollTop
}

/** From geometry alone, for when the layout moved under the reader without a scroll. */
export function settle(pin: Pin, el: Box): void {
  pin.stuck = atBottom(el)
  pin.top = el.scrollTop
}
