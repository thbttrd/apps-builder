/**
 * The reasoning trace, as its Thinking bubbles show it.
 *
 * A reply's flow holds one raw `thought` segment per non-empty reasoning part, in order:
 * newlines kept, nothing trimmed. Live, fold() (turns.ts) builds them from the `thought`
 * events; after a reload, from the stored reasoning parts. For every step that finished, the
 * two agree byte for byte — the SDK stores a step's reasoning as the concatenation of that
 * step's deltas, and a measured GLM turn of 1,566 deltas matched for every step. The SDK
 * records a step only at its finish-step, and chat.json holds only recorded steps (agent.ts):
 * a step cut off by Stop is shown live, but a reload has that step fewer, and a turn that
 * errored, or was stopped before its first step finished, is not stored at all. Only these
 * helpers trim: 6 of those 1,566 deltas were whitespace only, and they are part of the stored text.
 *
 * No imports, so the check suite loads this without React.
 */

/**
 * Enough to fill the Thinking card's three-line tail box at the chat's default widest, 38rem.
 * A chat dragged wider than that shows the same tail in fewer lines.
 */
const TAIL = 300

/**
 * A step's size, for its bubble: `38k`. Exact below 1000, one decimal below 10k (`1.5k`), whole
 * thousands above: the number says how much there is to read, not how much there is to count.
 */
export function sizeOf(step: string): string {
  const c = step.trim().length
  return c < 1000 ? `${c}` : c < 10_000 ? `${Math.round(c / 100) / 10}k` : `${Math.round(c / 1000)}k`
}

/**
 * What a closed step's bubble shows of it: its opening words, whitespace collapsed. Cut here,
 * at more than a line of the widest chat, so a 26k step is not laid out to show one line, nor
 * read out whole as the bubble's name; the bubble cuts it again at its edge.
 */
export const opening = (step: string) =>
  // By code point, so the cut never halves an emoji into a lone surrogate (review of #46).
  Array.from(step.trimStart().slice(0, 640).replace(/\s+/g, ' ')).slice(0, 160).join('').trimEnd()

/**
 * The last TAIL characters, whitespace collapsed, starting on a word. Cut to four tails'
 * worth first: one step's reasoning measured 26,683 characters, and this runs on every
 * send, four times a second.
 */
export function tail(s: string): string {
  const flat = s.slice(-4 * TAIL).replace(/\s+/g, ' ')
  if (flat.length <= TAIL) return flat
  const cut = flat.slice(-TAIL)
  const space = cut.indexOf(' ')
  return space >= 0 && space < 40 ? cut.slice(space + 1) : cut
}
