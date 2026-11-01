/**
 * One turn's stream, relayed: every part of the model's `fullStream` through the trace and
 * the tracker, and the text and tool parts on to the chat as the events it draws.
 *
 * This was the for-await loop inside chat(), and the check suite never ran it: the check
 * server has no key, and the browser smoke answers POST /chat from a stub in the page. So
 * `track.part` in place of `pace.part`, which leaves the live panel empty, or `pace.end()`
 * out of the `finally`, which leaves the timer running after `error` and can send held
 * reasoning after it, both kept every check green. It lives here so the suite drives this
 * loop over the SDK's own stream from a mock model.
 *
 * No imports at run time but activity.ts, ask.ts and labels.ts, which import nothing else.
 */
import type { TextStreamPart, ToolSet } from 'ai'
import { type Activity, type Thought, type activityOf, paceOf, traceOf } from './activity'
import type { AskedPlan } from './plan'
import { type Question, isAsk } from '../shared/ask'
import { toolDetail } from '../shared/labels'

/** The trace's clock and paceOf's timer: the real ones, unless a check holds them. */
export type Clock = { now: () => number; every: (flush: () => void, ms: number) => unknown; stop: (tick: unknown) => void }

export type ChatEvent =
  | { type: 'text'; text: string }
  /**
   * Sent up to three times per call: on `tool-input-start` (name only), on `tool-call`
   * (name and path) and on `tool-result`, which carries `done` and is the only one of
   * the three that means the filesystem has actually changed. Measured 2026-09-21: a
   * write_file's `tool-call` arrived 13.8s before the file existed, because every tool in
   * one assistant message executes only once that message has finished streaming.
   */
  | { type: 'tool'; id: string; name: string; path?: string; done?: true }
  /** Told to the model before the user's message — after it, when the message answers a
   *  question: files changed outside the chat. `after`: at the end of the turn instead —
   *  the ⚠ of a reply cut off at its output limit (cutOffNote). */
  | { type: 'note'; text: string; after?: true }
  /** An ask_user call. The turn ends on it; the next message is its answer. See ask.ts. */
  | { type: 'ask'; id: string; questions: Question[]; plan?: AskedPlan }
  /** What the model is doing in the gaps between the others. See activity.ts. */
  | ({ type: 'activity' } & Activity)
  /**
   * Reasoning, raw and complete: 4/s plus one per boundary, and nothing held longer than
   * 250 ms (the throttle and paceOf's timer can occasionally land a send each in the same
   * window). Folded per `fresh`, it is what chat.json stores for each step. See traceOf.
   */
  | ({ type: 'thought' } & Thought)
  /** The project's tally, once a step's or a look's cost is in it (see `book` in chat()). */
  | { type: 'spent'; usd: number }
  | { type: 'done'; usage: Usage; cost: number; usd: number; model: string; aborted: boolean }
  | { type: 'error'; message: string }

/**
 * On Anthropic, cacheWrite costs 2x input at the 1 h TTL loopModel sets (1.25x is the 5 min
 * rate) and cacheRead 0.1x or less, so both belong in the receipt.
 */
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number }

const REAL: Clock = {
  now: () => performance.now(),
  every: setInterval,
  stop: (tick) => clearInterval(tick as ReturnType<typeof setInterval>),
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

/**
 * Resolves with whether the turn was stopped once the stream ends, and rejects with whatever
 * broke it. Either way, by then everything it held has been sent and paceOf's timer has
 * stopped, so what chat() sends next, `done` or `error`, is the last thing on the wire.
 */
export async function relay<T extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<T>>,
  send: (e: ChatEvent) => void,
  track: ReturnType<typeof activityOf>,
  clock: Clock = REAL,
): Promise<{ aborted: boolean }> {
  // The trace and the tracker, in the order and on the timer paceOf documents.
  const pace = paceOf(traceOf((t) => send({ type: 'thought', ...t }), clock.now), track, clock.every, clock.stop)
  let aborted = false
  // A turn speaks in several text blocks — one per step that says anything — and
  // they arrive back to back: "…individual characters.Added a subtitle…". A paragraph
  // break goes in front of every block after the first, and only once that block
  // actually says something, so a block that turns out empty leaves no gap behind.
  // Whitespace is not saying something: GLM opens a step with a lone ' ', which drew as
  // blank lines above the next step's words until a reload. A block's leading whitespace
  // goes, as toTurns drops it on a reload.
  let said = false
  let open = false
  try {
    for await (const part of stream) {
      pace.part(part)
      if (part.type === 'abort') aborted = true
      if (part.type === 'text-start') open = false
      else if (part.type === 'text-delta' && part.text && (open || part.text.trim())) {
        const text = open ? part.text : part.text.trimStart()
        send({ type: 'text', text: said && !open ? `\n\n${text}` : text })
        said = open = true
      }
      // A question is a card, not a row: sent whole once its arguments are in, and only if
      // they parsed — an invalid call gets its error as a result and the model asks again.
      // Its other parts are dropped, so no `ask_user` or `ask_design` row appears (see ask.ts).
      else if ('toolName' in part && isAsk(part.toolName)) {
        if (part.type === 'tool-call' && !part.invalid) {
          const { questions, plan } = part.input as { questions: Question[]; plan?: AskedPlan }
          send({ type: 'ask', id: part.toolCallId, questions, ...(plan && { plan }) })
        }
      }
      // Announced before the arguments stream, so the row appears at once rather
      // than after the file has been generated. tool-call then fills the path in.
      // Only for a provider that streams arguments: GLM's arrive in one chunk once
      // the file is done, so for it the row and the path land together (activity.ts).
      else if (part.type === 'tool-input-start')
        send({ type: 'tool', id: part.id, name: part.toolName })
      else if (part.type === 'tool-call')
        send({ type: 'tool', id: part.toolCallId, name: part.toolName, path: toolDetail(part.toolName, part.input) })
      // The file is on disk by now. This is what the code pane refetches on.
      else if (part.type === 'tool-result')
        send({
          type: 'tool',
          id: part.toolCallId,
          name: part.toolName,
          path: toolDetail(part.toolName, part.input),
          done: true,
        })
      // A refused tool is still a done tool as far as the row is concerned. This
      // became reachable when the agent's three tools moved onto sourcePath(), which
      // throws for anything under node_modules/.git/dist/.apps-builder — before that
      // no tool here could throw. `ai` 7 enqueues a `tool-error` part and keeps the
      // loop going, so the model gets the refusal and the turn survives; without this
      // branch the row never receives `done` and spins for the rest of the session.
      else if (part.type === 'tool-error')
        send({
          type: 'tool',
          id: part.toolCallId,
          name: part.toolName,
          path: toolDetail(part.toolName, part.input),
          done: true,
        })
      else if (part.type === 'error') throw part.error
    }
  } catch (e) {
    // An abort is a normal way for a turn to end, not a failure.
    if (!isAbort(e)) throw e
    aborted = true
  } finally {
    // However the stream ended — finished, stopped, thrown — the reasoning it held
    // goes out before `done` or `error`, and the timer stops with it so nothing is
    // sent after either.
    pace.end()
  }
  return { aborted }
}
