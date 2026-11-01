/**
 * What the model is doing between the events a turn already sends, so a quiet stretch in
 * the chat reads as work and not as a hang — and, separately, the reasoning itself.
 *
 * Measured 2026-09-23 on z-ai/glm-5.3-flash, "I want a paint application": the third step
 * reasoned for 85 s — 26,683 characters in 2,617 deltas — before its first visible word,
 * and every one of those parts was dropped, so the bubble sat still for a minute and a
 * half. The same run showed the second gap: this provider sends a write_file's arguments
 * in one chunk once the whole file exists (4–6 kB, 12–19 s after the text before it), so
 * `tool-input-start` cannot announce the row early for it the way it does for a model
 * that streams arguments. Nothing arrives in that gap to show; "writing · 19s" is the
 * honest amount.
 *
 * "running" comes from the tool itself starting, never from `tool-call`: the SDK runs a
 * message's tools only once the whole message has streamed, so a call means the model has
 * finished writing that call, not that anything is running. Labelled off the call, a
 * dev turn read "running write_file src/paint/icons.tsx" for as long as GLM spent
 * silently writing the file after it.
 *
 * The reasoning is not part of the activity any more. It used to ride along as `what`,
 * cut to a 300-character tail, which is all the bubble could ever show of it. It now goes
 * out whole through traceOf() as `thought` events, and the client keeps it per step, so
 * the person can read every word of it live and after a reload alike. The tail box is cut
 * on the client, from the same text.
 *
 * No imports but labels.ts, which has none either: the check suite drives this directly.
 */
import { toolDetail } from '../shared/labels'

export type Doing = 'waiting' | 'thinking' | 'writing' | 'running' | 'saving'
/**
 * `what` is the tool, and only the tool: named while its arguments stream, labelled with
 * its detail while check_app runs. The reasoning travels as `thought`; see traceOf.
 */
export type Activity = { doing: Doing; what?: string }

/**
 * More of one reasoning part, raw: newlines kept, nothing trimmed. `fresh` opens a new part
 * (one per step on this provider). Concatenated per part, the texts are exactly the
 * reasoning part chat.json stores for that step — measured byte for byte on GLM over two
 * turns, 1,585 deltas, 6 of them whitespace only. So nothing on this path may drop, trim or
 * skip a delta; only what the client displays is trimmed.
 */
export type Thought = { text: string; fresh?: true }

/** Deltas arrive ~30 a second; four sends a second is plenty to read as alive. */
export const EVERY_MS = 250

type Part = { type: string; text?: string; toolName?: string; input?: unknown }

/**
 * `part` takes every part of the model's stream; `runs` is called by a tool as it
 * starts executing. Both go through one tracker so a repeat can be told from news.
 */
export function activityOf(send: (a: Activity) => void) {
  let current = ''
  let doing: Doing | undefined
  const set = (a: Activity) => {
    // Only news when it changes. The reasoning no longer moves `what`, so thinking repeats
    // like everything else: a delta arrives ~30 times a second and each one says "thinking";
    // reasoning-end and text-start both mean "writing" and often arrive back to back.
    const key = `${a.doing} ${a.what ?? ''}`
    if (key === current) return
    current = key
    doing = a.doing
    send(a)
  }

  const part = (part: Part) => {
    switch (part.type) {
      // From a delta that says something, not from reasoning-start: a reasoning part can
      // open and stay empty (the SDK stores it as `""`), and that step must not read as
      // thinking. The step's first `thought`, sent from the same delta just before this,
      // is then always on the wire ahead of its label. Every delta repeats it, which the
      // dedupe makes free, so reasoning that resumes after a tool call still says thinking.
      case 'reasoning-delta':
        if (part.text) set({ doing: 'thinking' })
        break
      // Only from thinking. GLM closes its reasoning at the very end of a step, after the
      // tool calls it made — by then the calls have moved the label on, and this is not news.
      case 'reasoning-end':
        if (doing === 'thinking') set({ doing: 'writing' })
        break
      case 'text-start':
        set({ doing: 'writing' })
        break
      // Named while its arguments stream — for a model that streams them. Once the call is
      // complete the model may still be writing the rest of its message, so back to plain.
      case 'tool-input-start':
        set({ doing: 'writing', what: part.toolName })
        break
      case 'tool-call':
        set({ doing: 'writing' })
        break
      // The tools have run and their results are going back up: the next request is out.
      case 'finish-step':
        set({ doing: 'waiting' })
        break
      // The model is done, or was stopped: `ai` 7 ends an aborted stream with `abort` and
      // no `finish`, and a stopped turn is persisted all the same. Without this, Stop left
      // the line on "thinking" with its clock running through the save. Either way,
      // chat.json and the checkpoint commits are what is left.
      case 'finish':
      case 'abort':
        set({ doing: 'saving' })
        break
    }
  }
  const runs = (name: string, input: unknown) =>
    set({ doing: 'running', what: [name, toolDetail(name, input)].filter(Boolean).join(' ') })
  return { part, runs }
}

/**
 * The reasoning, whole, batched to at most one send per EVERY_MS. Not folded into
 * activityOf because the two are throttled and deduplicated differently: a phase is sent
 * once when it changes, and reasoning is sent every time there is more of it.
 *
 * A step's first delta goes out at once, so the tail box never shows the last step's
 * words under a new "thinking". Every other part flushes what is held before it is acted
 * on — paceOf() feeds a part here before activityOf — so no reasoning is ever sent after
 * the news that ended it. `flush` is also paceOf's to call: on a timer, because GLM can go
 * 12–19 s with no part at all after its last delta, and once more when the stream ends,
 * however it ends.
 */
export function traceOf(send: (t: Thought) => void, now: () => number = () => performance.now()) {
  let pending = ''
  let fresh = false
  let sentAt = -Infinity
  const flush = () => {
    // An empty flush sends nothing and leaves `fresh` armed. The timer, or an empty delta,
    // can flush between a reasoning-start and that step's first word, and the step must
    // still open its own entry on the client, as it has its own part in chat.json.
    if (!pending) return
    send(fresh ? { text: pending, fresh: true } : { text: pending })
    pending = ''
    fresh = false
    sentAt = now()
  }
  const part = (p: Part) => {
    if (p.type !== 'reasoning-delta') {
      flush()
      if (p.type === 'reasoning-start') fresh = true
      return
    }
    pending += p.text ?? ''
    if (fresh || now() - sentAt >= EVERY_MS) flush()
  }
  return { part, flush }
}

/**
 * One turn's wiring of the two. It lives here, not in agent.ts, so the check suite runs
 * the code the server runs:
 * - Every part goes to the trace first and the tracker second, so whatever reasoning is
 *   held goes out before the phase it ended, and a step's first thought before the
 *   "thinking" it starts.
 * - A flush runs every EVERY_MS, because the throttle only ever sends on the next delta
 *   and GLM can go 12–19 s with no part at all after its last one (a write_file it sends
 *   in one piece). This is what puts the last ≤250 ms of reasoning on screen meanwhile.
 * - end() is the last flush, with the timer stopped, so nothing is sent after `done` or
 *   `error`.
 * The timer is passed in so a check can tick it by hand.
 */
export function paceOf<T>(
  trace: ReturnType<typeof traceOf>,
  track: ReturnType<typeof activityOf>,
  every: (flush: () => void, ms: number) => T,
  stop: (tick: T) => void,
) {
  const tick = every(trace.flush, EVERY_MS)
  return {
    part: (p: Part) => {
      trace.part(p)
      track.part(p)
    },
    end: () => {
      trace.flush()
      stop(tick)
    },
  }
}
