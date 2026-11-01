/**
 * What more than one test file needs: the assertion, the scratch directory, the mock model's
 * usage, the GLM history, and the harnesses that replay a stream through the server's own
 * relay and pacing. The design fixtures are here too, because check-preview's design routes
 * serve the same page the design tests check.
 */
import { join } from 'node:path'
import { expect } from 'bun:test'
import type { TextStreamPart, ToolSet } from 'ai'
import type { ChatEvent } from '../server/stream'
import { type Activity, type Thought, activityOf, paceOf, traceOf } from '../server/activity'
import { type Clock, relay } from '../server/stream'
import type { Brief } from '../server/design'
import type { DocSections } from '../server/design-doc'
import type { CheckOptions } from '../server/design-check'
import { type Reply, type Segment, type StoredMessage, type Turn, fold } from '../src/turns'

/** The suite's assertion: its sentence is the failure message, as it was in check-preview. */
export function check(ok: boolean, what: string): void {
  expect(ok, what).toBeTrue()
}

/**
 * Every test's scratch projects live under here (setup.ts points AB_PROJECTS_DIR at it, and
 * removes it at the end). Not read from AB_PROJECTS_DIR: run without setup.ts, that is the real
 * one, and the suites' own rm and restore's guard would both be on it.
 */
export const TMP = join(import.meta.dir, '..', '.check-tests')

/** What a mock model reports per request: enough for the SDK, too little to cost anything. */
export const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}

/** Reasoning with whitespace at both ends and a blank line inside, then a short second step. */
export const R1 = '  Plan:\n\n1. read\n2. blue  \n'
export const R2 = 'Done — check.\n'
/** A reasoning text streamed a character at a time. */
export const reasoning = (id: string, text: string) => [...text].map((delta) => ({ type: 'reasoning-delta' as const, id, delta }))

/** A plan of numbered steps in the given statuses. */
export const planOf = (...st: ('pending' | 'doing' | 'done')[]) => ({
  steps: st.map((status, i) => ({ title: `S${i + 1}`, contract: `does ${i + 1}`, status })),
})

/**
 * A GLM turn as chat.json stores it: a step per assistant message, reasoning first in each.
 * Rebuilt by toTurns in the chat tests, and written into the project the browser smoke opens.
 */
export const GLM_CHAT: StoredMessage[] = [
  { role: 'user', content: 'a paint app' },
  { role: 'assistant', content: [
    { type: 'reasoning', text: 'Plan the canvas.\n\nThen tools.', providerOptions: { openrouter: { reasoning_details: [{ type: 'reasoning.text', text: 'Plan the canvas.\n\nThen tools.' }] } } },
    { type: 'tool-call', toolCallId: 'a', toolName: 'write_file', input: { path: 'src/Paint.tsx' } },
  ] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'write_file', output: { type: 'text', value: 'wrote src/Paint.tsx (9 bytes)' } }] },
  { role: 'assistant', content: [
    { type: 'reasoning', text: '', providerOptions: { openrouter: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'x' }] } } },
    { type: 'tool-call', toolCallId: 'b', toolName: 'check_app', input: { path: '/' } },
  ] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'check_app', output: { type: 'text', value: 'no errors' } }] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'Check it on a phone.' }, { type: 'text', text: 'Done.' }] },
  { role: 'user', content: 'why?' },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'Because.' }] },
]

// ── design ─────────────────────────────────────────────────────────────────

/** A design example that passes the check: its own tokens, its fonts, the app's name. */
export const GOOD = await Bun.file(join(import.meta.dir, 'fixtures', 'designs', 'good.html')).text()
/** The good page in another palette: another design, which passes too. */
export const repaint = (canvas: string, primary: string) =>
  GOOD.replace('--color-canvas: #faf9f5;', `--color-canvas: ${canvas};`).replace('--color-primary: #cc785c;', `--color-primary: ${primary};`)
export const lit: CheckOptions = { app: 'Tip Splitter', theme: 'light', others: [] }
export const briefL: Brief = {
  answer: '',
  picks: { Mood: 'Warm & friendly', Theme: 'Light', Density: 'Balanced', Inspiration: 'Claude' },
  inspiration: 'claude',
  offered: ['claude', 'linear.app', 'notion', 'stripe'],
}
/** DESIGN.md's sections, as save_design_md takes them. */
export const SECTIONS: DocSections = {
  description: 'A receipt on warm cream paper, with terracotta for the one thing to press.',
  overview: 'Tip Splitter reads like a restaurant receipt: cream paper, a serif for the figures.',
  colors: 'The canvas is the paper. {colors.primary}, #cc785c, is Split the bill and nothing else.',
  typography: 'Newsreader for the figures and headings; DM Sans for everything else.',
  layout: 'One column on a phone; the bill beside who pays from a tablet up.',
  elevation: 'Flat: cards are the surface colour, with no shadow but the button’s.',
  shapes: 'Cards take rounded.lg, fields and the button rounded.md, chips rounded.sm.',
  components: 'button-primary is the one action; button-secondary the people chips.',
  dos: ['Keep the canvas cream.', '- Put every amount in Newsreader.'],
  donts: ['Never a second accent colour.'],
  responsive: 'Phone: stacked, the total in a sticky bar. Desktop: two columns, the receipt on the right.',
}

// ── stream harnesses ───────────────────────────────────────────────────────

/**
 * Feeds parts through paceOf, the wiring agent.ts runs, on a fake clock and a fake timer:
 * every stream part to the trace first and the tracker second, a `run` to the tracker
 * alone, as check_app's execute() does, and a `tick` to the timer paceOf asked for, as
 * setInterval would every EVERY_MS. `log` has both in the order they would reach the wire:
 * `thought[ fresh]`, `doing[ what]`. `end` is the stream ending; `ticking` says whether
 * the timer is still running.
 */
export function replay(parts: (readonly [number, { type: string; text?: string; toolName?: string; input?: unknown }])[]) {
  let now = 0
  const log: string[] = []
  const said: Activity[] = []
  const sent: Thought[] = []
  const at: number[] = []
  const trace = traceOf(
    (t) => {
      sent.push(t)
      at.push(now)
      log.push(t.fresh ? 'thought fresh' : 'thought')
    },
    () => now,
  )
  const track = activityOf((a) => {
    said.push(a)
    log.push(a.what ? `${a.doing} ${a.what}` : a.doing)
  })
  const ticks: number[] = []
  let ticker: (() => void) | undefined
  const pace = paceOf(
    trace,
    track,
    (flush, ms) => {
      ticks.push(ms)
      ticker = flush
      return ms
    },
    () => {
      ticker = undefined
    },
  )
  for (const [t, part] of parts) {
    now = t
    if (part.type === 'run') track.runs(part.toolName ?? '', part.input)
    else if (part.type === 'tick') ticker?.()
    else pace.part(part)
  }
  return { log, said, sent, at, ticks, tick: () => ticker?.(), end: pace.end, ticking: () => ticker !== undefined }
}

/**
 * Runs relay(), chat()'s own loop, over a stream: the tracker sends into the same log the
 * way chat()'s `tell` does, the clock moves 10 ms a part, and paceOf's timer is held here.
 * `onPart` sees each part as relay() is handed it. Once the stream ends, whichever way, the
 * log gets what chat() sends next, `done` or `error`, and then the timer fires if it is still
 * set, as it would 250 ms later. `order` is the kinds of event in the order they went out,
 * the activity left out and repeats run together; `text` is every word as it went out, and
 * `thoughts` and `flow` the reply the client folds them into.
 */
export async function relayed<T extends ToolSet>(
  stream: AsyncIterable<TextStreamPart<T>>,
  onPart?: (p: TextStreamPart<T>) => void,
) {
  let now = 0
  const events: ChatEvent[] = []
  const send = (e: ChatEvent) => void events.push(e)
  let tick: (() => void) | undefined
  const clock: Clock = {
    now: () => now,
    every: (flush) => (tick = flush),
    stop: () => (tick = undefined),
  }
  async function* clocked() {
    for await (const p of stream) {
      now += 10
      onPart?.(p)
      yield p
    }
  }
  let aborted: boolean | undefined
  let error: unknown
  try {
    ;({ aborted } = await relay(clocked(), send, activityOf((a) => send({ type: 'activity', ...a })), clock))
    send({ type: 'done', aborted, cost: 0, usd: 0, model: 'mock', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } })
  } catch (e) {
    error = e
    send({ type: 'error', message: String(e) })
  }
  const ticking = tick !== undefined
  tick?.()
  const kinds = events.map((e) => e.type).filter((k) => k !== 'activity')
  const reply = folded(events)
  return {
    aborted,
    error,
    ticking,
    events,
    order: kinds.filter((k, i) => k !== kinds[i - 1]).join(', '),
    thoughts: thoughtsOf(reply),
    text: events.map((e) => (e.type === 'text' ? e.text : '')).join(''),
    flow: reply.flow,
  }
}

/** The reply the client folds these events into. */
export const folded = (events: ChatEvent[]): Reply => events.reduce(fold, { id: 'live', role: 'assistant', flow: [] })

const segments = <K extends Segment['kind']>(t: Turn | undefined, kind: K) =>
  t?.role === 'assistant' ? t.flow.filter((s): s is Extract<Segment, { kind: K }> => s.kind === kind) : []
/** A reply's reasoning, one raw string per step, read off its flow. */
export const thoughtsOf = (t: Turn | undefined) => segments(t, 'thought').map((s) => s.text)
/** A reply's tool rows, every run of them, in order. */
export const toolsOf = (t: Turn | undefined) => segments(t, 'tools').flatMap((s) => s.tools)
/** The turn if it is a reply: its question card and plan are read off this. */
export const replyOf = (t: Turn | undefined) => (t?.role === 'assistant' ? t : undefined)
/** Whether a user turn is one the server wrote (see Turn). */
export const noteOf = (t: Turn | undefined) => t?.role === 'user' && !!t.note
/** A user turn's text, or a reply's words, its blocks as paragraphs. */
export const textOf = (t: Turn | undefined) =>
  t?.role === 'user' ? t.text : segments(t, 'text').map((s) => s.text).join('\n\n')
