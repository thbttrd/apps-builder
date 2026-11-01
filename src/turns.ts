/**
 * A chat as <Chat> draws it: the turns, each reply's flow, and how a reply grows — one event at
 * a time live (fold), or rebuilt from the stored history on a reload (toTurns). Pure: the store
 * that holds them, and the stream that feeds them, are chatStore.ts.
 */
import type { AskedPlan, ChatEvent as Event } from './api'
import { type Question, isAsk, pending } from '../shared/ask'
import { toolDetail } from '../shared/labels'

/**
 * One tool call's row: the tool, and what it is about (labels.ts) once its arguments have
 * streamed. `done` once the call has run: a write or an edit then has its diff to show (Chat).
 */
export type Tool = { id: string; name: string; detail?: string; done?: true }

/**
 * `note` is a user turn the server wrote, not the person: ✎ files changed outside the
 * chat, ⟲ a code-only restore, ◆ the design phase, ⚠ a reply cut off at its output limit. Told
 * to the model as user turns so the person sees them too — but shown as notes, not as
 * something they said.
 *
 * `id` is what <Chat> keys the turn's row by, so what the row holds — an open reasoning
 * panel and where it is scrolled to, an open ✎ note — stays with the turn. The key used to
 * be the row's index. A turn that was never stored drops out of the list a code+chat
 * restore reloads, the rows after it move up two, and each kept its index's state: the
 * reader's open panel closed and the one two rows down opened at its offset. A reloaded
 * turn's id is the index of its first stored message and a hash of the history up to and
 * including it (see toTurns); a live turn's is `live N`, and never equals one. When a
 * reload rebuilds a live turn it gets a stored id, so its row starts over, closed.
 *
 * `ask` is the questions an assistant turn ended on (see shared/ask.ts), and only until they
 * are answered: on the newest assistant turn, with at most a ⟲ restore note after it. `askId`
 * is its call's id, which the card's answer names (a stale card is refused, agent.ts chat()).
 *
 * `plan` is the build plan an assistant turn put to the person, as code put it in the
 * question's call (ask_user in server/tools.ts): kept after the answer, unlike `ask`, so the
 * history shows what was approved.
 *
 * `flow` is an assistant turn's content: its reasoning, words and tool rows in the order they
 * came, which is how <Chat> draws it — each step's thinking, then what it said and did. It is
 * the only copy: fold() writes it, live and on a reload, and a step's thoughts, the words and
 * the rows are read off it.
 */
export type Turn =
  | { id: string; role: 'user'; text: string; note?: true }
  | { id: string; role: 'assistant'; flow: Segment[]; ask?: Question[]; askId?: string; plan?: AskedPlan }
export type Reply = Extract<Turn, { role: 'assistant' }>

/** A run of one kind in an assistant turn: one step's reasoning, a run of words, a run of rows. */
export type Segment = { kind: 'thought'; text: string } | { kind: 'text'; text: string } | { kind: 'tools'; tools: Tool[] }

/** A reply with nothing in it yet: what send() shows until the first event lands. */
export const reply = (id: string): Reply => ({ id, role: 'assistant', flow: [] })
/** Whether a reply has said anything yet: a block of words after that gets a paragraph break first. */
const spoke = (t: Reply) => t.flow.some((s) => s.kind === 'text')

/**
 * `t` with one event in it. Every change to a reply's content comes through here — each live
 * event, the ⏹ and ⚠ lines the client adds (said), and on a reload each stored part as the event
 * that carried it (storedEvent) — so live and reloaded cannot draw it differently.
 *
 * A fresh thought opens a step's bubble and any other extends the newest; words extend a run of
 * words, and open one with their leading whitespace gone, as relay() and toTurns trim a block; a
 * tool row joins a run of rows, or replaces its own by id as its detail arrives. The server sends
 * a step's held reasoning before the part that ended it (paceOf), so the order here is the stream's.
 */
export function fold(t: Reply, e: Event): Reply {
  const { flow } = t
  const last = flow.at(-1)
  if (e.type === 'thought') {
    const at = flow.findLastIndex((s) => s.kind === 'thought')
    return {
      ...t,
      flow:
        e.fresh || at < 0
          ? [...flow, { kind: 'thought', text: e.text }]
          : flow.map((s, i) => (i === at && s.kind === 'thought' ? { kind: 'thought', text: s.text + e.text } : s)),
    }
  }
  if (e.type === 'text') {
    const words = e.text.trimStart()
    return {
      ...t,
      flow:
        last?.kind === 'text'
          ? [...flow.slice(0, -1), { kind: 'text', text: last.text + e.text }]
          : words
            ? [...flow, { kind: 'text', text: words }]
            : flow,
    }
  }
  if (e.type !== 'tool') return t
  const row: Tool = { id: e.id, name: e.name, ...(e.path && { detail: e.path }), ...(e.done && { done: true as const }) }
  if (flow.some((s) => s.kind === 'tools' && s.tools.some((x) => x.id === e.id))) {
    return { ...t, flow: flow.map((s) => (s.kind === 'tools' ? { ...s, tools: s.tools.map((x) => (x.id === e.id ? row : x)) } : s)) }
  }
  return {
    ...t,
    flow: last?.kind === 'tools' ? [...flow.slice(0, -1), { kind: 'tools', tools: [...last.tools, row] }] : [...flow, { kind: 'tools', tools: [row] }],
  }
}

/** A line of the client's own at the end of a turn — ⏹ stopped, ⚠ an error — as words of it. */
export const said = (t: Reply, line: string) => fold(t, { type: 'text', text: `${spoke(t) ? '\n\n' : ''}${line}` })

/**
 * A stored part as the live event that carried it, or null for one no event draws. `t` is the
 * turn so far: a block of words after others gets the paragraph break relay() puts in front of
 * it. `id` stands in for a call stored without one, so two such rows do not fold into one.
 */
function storedEvent(p: Part, t: Reply, id: string): Event | null {
  if (p.type === 'reasoning' && p.text) return { type: 'thought', text: p.text, fresh: true }
  if (p.type === 'text' && p.text?.trim()) return { type: 'text', text: (spoke(t) ? '\n\n' : '') + p.text.trimStart() }
  if (p.type === 'tool-call' && !isAsk(p.toolName))
    return { type: 'tool', id: p.toolCallId || id, name: p.toolName ?? '', path: toolDetail(p.toolName ?? '', p.input), done: true }
  return null
}

const isNote = (text: string) => /^[✎⟲◆⚠]/.test(text)

export type StoredMessage = { role: string; content: unknown }

/**
 * Stored history is ModelMessage[]: one assistant message per step, with tool results in
 * `tool` messages between them. Live, a turn is one reply with its tool rows on top; so
 * consecutive assistant messages fold back into one turn here, text blocks joined as
 * paragraphs the way the server now streams them, and the rows rebuilt from the calls.
 * Before this a reload split one turn into a reply per step and dropped every row.
 *
 * The reasoning comes back the same way: one entry per step whose stored reasoning is not
 * empty, raw, which is exactly what the live `thought` events built for every step that
 * finished. A step cut off by Stop never reached chat.json, so it is not here, and neither
 * is any of a turn that errored or was stopped before its first step finished.
 *
 * A turn's id is `k.h`: k is the index of its first message, h a hash of every message up
 * to and including that one. The index alone would do if chat.json only grew, as it does at
 * a turn's end and in noteRestore(). But a code+chat restore puts back the file as it was at
 * the snapshot, and after a turn that followed an earlier code+chat restore, that file and
 * the current one part ways at that turn: the same index names a different turn in each.
 * The hash takes what the turn shows and its tool calls' ids, not their inputs, which hold
 * whole files.
 *
 * An answer to ask_user is stored as the call's result, in a `tool` message, but it is what
 * the person said, so it comes back as their turn, as it was shown live.
 */
export function toTurns(messages: StoredMessage[]): Turn[] {
  const turns: Turn[] = []
  let h = 0x811c9dc5
  for (const [k, m] of messages.entries()) {
    const answer = m.role === 'tool' ? answerIn(m.content) : undefined
    if (answer !== undefined) {
      h = mix(h, m.role, answer)
      turns.push({ id: `${k}.${h.toString(36)}`, role: 'user', text: answer })
    } else if (m.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : parts(m.content).texts.join('\n\n')
      h = mix(h, m.role, text)
      const id = `${k}.${h.toString(36)}`
      if (text) turns.push({ id, role: 'user', text, ...(isNote(text) && { note: true as const }) })
    } else if (m.role === 'assistant') {
      const { texts, calls, thoughts, plan } =
        typeof m.content === 'string' ? { texts: [m.content], calls: [], thoughts: [] } : parts(m.content)
      h = mix(h, m.role, ...texts, ...calls, ...thoughts)
      const id = `${k}.${h.toString(36)}`
      const last = turns.at(-1)
      let turn: Reply = last?.role === 'assistant' ? last : reply(id)
      const list: Part[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
      for (const [j, p] of list.entries()) {
        const e = storedEvent(p, turn, `${k}.${j}`)
        if (e) turn = fold(turn, e)
      }
      if (plan) turn = { ...turn, plan }
      if (turn.id === last?.id) turns[turns.length - 1] = turn
      else turns.push(turn)
    } else h = mix(h, m.role)
  }
  // Only the newest assistant message can hold an open question, so it is its turn's.
  const open = pending(messages)
  const asker = turns.findLast((t) => t.role === 'assistant')
  if (open && asker) Object.assign(asker, { ask: open.questions, askId: open.ids[0] })
  return turns.filter(shows)
}

/**
 * Whether a turn has anything to draw. A turn whose steps only reasoned, with no word and no
 * tool, still has its reasoning: live it had its thinking line, so a reload keeps it. A turn
 * that only asked has nothing once it is answered — its questions are in the answer.
 */
export const shows = (t: Turn) =>
  t.role === 'user' ? !!t.text.trim() : !!(t.ask || t.plan || t.flow.some((s) => s.kind !== 'text' || s.text.trim()))

/** The answer a `tool` message carries for ask_user, if it is one: every open call got the
 *  same text (see chat() in server/agent.ts), so the first is the answer. */
function answerIn(content: unknown): string | undefined {
  const list = Array.isArray(content) ? (content as { toolName?: string; output?: { type?: string; value?: unknown } }[]) : []
  // 'text' only, as answer() writes it: a call that failed the schema has the SDK's error as
  // its result ('error-text'), which is no answer and was drawn as the person's message.
  const value = list.find((p) => isAsk(p.toolName) && p.output?.type === 'text')?.output?.value
  return typeof value === 'string' ? value : undefined
}

/** FNV-1a, with a NUL after each piece so that ['ab', 'c'] and ['a', 'bc'] differ. */
function mix(h: number, ...pieces: string[]): number {
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) h = Math.imul(h ^ piece.charCodeAt(i), 0x01000193)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

type Part = { type?: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown }

/** What a stored message's parts are for its turn's id and its user text: the words, the rows' call ids, the thoughts, the plan. */
function parts(content: unknown): { texts: string[]; calls: string[]; thoughts: string[]; plan?: AskedPlan } {
  const list = Array.isArray(content) ? (content as Part[]) : []
  return {
    // Blank ones too: GLM opens a step that only calls a tool with a text part of one space,
    // which drew an empty paragraph — a gap above every question it asked (2026-09-25).
    // Trimmed at the start as relay trims a block live, so a reload draws what the turn drew.
    texts: list.filter((p) => p.type === 'text' && p.text?.trim()).map((p) => (p.text as string).trimStart()),
    // A question is a card, never a row — live, relay() sends no row for one either.
    calls: list.filter((p) => p.type === 'tool-call' && !isAsk(p.toolName)).map((p) => p.toolCallId ?? ''),
    // An empty one is skipped here as the server skips it live: the SDK stores a reasoning
    // part that never said anything as `""`; only an empty text part is dropped.
    thoughts: list.filter((p) => p.type === 'reasoning' && p.text).map((p) => p.text as string),
    plan: list
      .filter((p) => p.type === 'tool-call' && isAsk(p.toolName))
      .map((p) => (p.input as { plan?: AskedPlan } | null)?.plan)
      .findLast(Boolean),
  }
}
