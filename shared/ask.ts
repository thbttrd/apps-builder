/**
 * ask_user and ask_design, the tools with no execute(). `ai` 7 cannot run such a call, so the
 * loop stops on it: probed 2026-09-25 with a mock model, one model call, the stream ends on `finish`,
 * and the stored step ends on the call with no result. The turn is over, saved and committed
 * like any other; the person's next message is the call's result.
 *
 * Shared by the server, which turns that message into the result, and the client, which
 * rebuilds the question card from stored history. No imports: the client bundle pulls this
 * file in whole.
 */
export type Question = {
  question: string
  header: string
  /** `swatches`: a design's colours, drawn beside it (ask_design's inspirations). */
  options: { label: string; description?: string; swatches?: string[] }[]
  multiSelect: boolean
}

/**
 * The tools that ask: ask_user, whose questions the model writes, and ask_design, whose card
 * code builds (server/design.ts) — into the call's own input, so from here on the two are one.
 */
export const isAsk = (name: string | undefined) => name === 'ask_user' || name === 'ask_design'

type Message = { role: string; content: unknown }
type Part = { type?: string; toolCallId?: string; toolName?: string; input?: unknown; providerOptions?: unknown }

const partsOf = (content: unknown): Part[] => (Array.isArray(content) ? (content as Part[]) : [])

/**
 * The questions still waiting for an answer — the ask_user calls in the newest assistant
 * message that no tool message after it answers — and `at`, where their answer goes: right
 * after that message, not at the end. A code-only restore appends its ⟲ note to chat.json
 * with the question still open, and a call's result has to follow the call.
 *
 * A call the SDK found invalid already has its error as a result, so it is never pending.
 */
export function pending(
  messages: readonly Message[],
): { at: number; ids: string[]; names: string[]; questions: Question[] } | null {
  const at = messages.findLastIndex((m) => m.role === 'assistant')
  if (at < 0) return null
  const answered = new Set(
    messages.slice(at + 1).flatMap((m) => (m.role === 'tool' ? partsOf(m.content).map((p) => p.toolCallId) : [])),
  )
  const open = partsOf(messages[at]!.content).filter(
    (p) => p.type === 'tool-call' && isAsk(p.toolName) && !answered.has(p.toolCallId),
  )
  if (!open.length) return null
  return {
    at: at + 1,
    ids: open.map((p) => p.toolCallId ?? ''),
    names: open.map((p) => p.toolName ?? ''),
    questions: open.flatMap((p) => (p.input as { questions?: Question[] } | null)?.questions ?? []),
  }
}

/**
 * `past` with `message` in it as the answer to the question it ended on, as that call's
 * result — or null when no question is open and the message is just the next user turn.
 * Every open call gets the whole answer, which names each question it answers.
 */
export function answer<M extends Message>(past: readonly M[], message: string): M[] | null {
  const open = pending(past)
  if (!open) return null
  const result = {
    role: 'tool',
    content: open.ids.map((toolCallId, i) => ({
      type: 'tool-result',
      toolCallId,
      toolName: open.names[i],
      output: { type: 'text', value: message },
    })),
  } as unknown as M
  return [...past.slice(0, open.at), result, ...past.slice(open.at)]
}

/**
 * From where `unreasoned` keeps reasoning: the assistant message whose question `past` ends
 * on, when one is open — the answer is that call's result, and Anthropic wants the thinking
 * back on the message a tool result answers — or nowhere, since a new message starts a new
 * turn. Not from the start of the turn that asked: in a gated build every turn after the
 * first is an answer, so that kept a whole build's reasoning, back to its first prompt
 * (measured on the plants app: nothing was cut).
 */
export function turnStart(past: readonly Message[]): number {
  const open = pending(past)
  return open ? open.at - 1 : past.length
}

/**
 * Where `unreasoned` stops cutting for `model`: at the turn being continued, except for Anthropic's,
 * which keep every turn's reasoning. Their cache write is paid (1.25x), and each turn's first step
 * re-wrote the history the strip had just changed: on dev's 17 Anthropic turns 110k of 250k input
 * tokens a turn, 5-10x what the strip saved (traces, 2026-10-22). GLM's cache writes are free.
 */
export function reasonedFrom(model: string, past: readonly Message[]): number {
  return /^~?anthropic\//.test(model) ? 0 : turnStart(past)
}

/**
 * `messages` as the model is sent them: the assistant messages before `from` without their
 * reasoning. chat.json keeps it — the Thinking panels read it from there.
 *
 * `@openrouter/ai-sdk-provider` puts every stored reasoning back on the request twice, as
 * `reasoning` and as `reasoning_details`, and it takes the details from a tool-call part's
 * providerOptions before a reasoning part's — GLM stores them on both. Measured 2026-09-26 on
 * a 60-message build: 113k of its 220k characters, and a turn read 73 172 tokens. So both go:
 * the reasoning parts, and the details on every other part. A message left with nothing —
 * a step that only reasoned — goes too.
 *
 * Kept from `from` on (see turnStart): Anthropic wants the thinking back on the message a
 * tool result answers, and answering a question is that.
 */
export function unreasoned<M extends Message>(messages: readonly M[], from: number): M[] {
  return messages.flatMap((m, i) => {
    if (i >= from || m.role !== 'assistant' || !Array.isArray(m.content)) return [m]
    const content = (m.content as Part[]).filter((p) => p.type !== 'reasoning').map(undetailed)
    return content.length ? [{ ...m, content }] : []
  })
}

/**
 * `messages` without the plan code put in each ask_user call (tools.ts): it is for the chat to
 * draw, and the model has it in its own update_plan calls. Sent back, every question under the
 * step gate carried one more copy of every step's contract for the rest of the conversation
 * (review of #46).
 */
export function withoutPlans<M extends Message>(messages: readonly M[]): M[] {
  const planned = (p: Part) => p.type === 'tool-call' && isAsk(p.toolName) && !!(p.input as { plan?: unknown } | null)?.plan
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content) || !(m.content as Part[]).some(planned)) return m
    const content = (m.content as Part[]).map((p) => {
      if (!planned(p)) return p
      const { plan: _, ...input } = p.input as Record<string, unknown>
      return { ...p, input }
    })
    return { ...m, content }
  })
}

function undetailed(p: Part): Part {
  const options = p.providerOptions as { openrouter?: Record<string, unknown> } | undefined
  if (!options?.openrouter || !('reasoning_details' in options.openrouter)) return p
  const { reasoning_details: _, ...openrouter } = options.openrouter
  return { ...p, providerOptions: { ...options, openrouter } }
}

/**
 * What the card sends: a line per question, `question → picks`. It goes down as an ordinary
 * chat message, so an answer typed in the composer instead is just as good. A question left
 * unpicked says so, and the model decides it — the card never refuses a submit.
 */
export function answerOf(questions: readonly Question[], picks: readonly (readonly string[])[]): string {
  return questions
    .map((q, i) => `${q.question} → ${picks[i]?.length ? picks[i].join(', ') : 'no preference'}`)
    .join('\n')
}

/**
 * `messages` with every write_design's page cut to a line: the page is on disk, and a later
 * turn resending three of them, 10–40 KB each, pays for them on every step to the end of the
 * build. The running turn's own attempts are not in `messages` — the SDK adds its steps — so a
 * retry still sees the page it is fixing. chat.json keeps them whole.
 */
export function withoutHtml<M extends { role: string; content: unknown }>(messages: readonly M[]): M[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return m
    let cut = false
    const content = (m.content as { type?: string; toolName?: string; input?: { id?: unknown; html?: unknown } }[]).map((p) => {
      if (p.type !== 'tool-call' || p.toolName !== 'write_design' || typeof p.input?.html !== 'string') return p
      cut = true
      return { ...p, input: { ...p.input, html: `(${p.input.html.length} characters, not repeated; a page that passed is .apps-builder/designs/${String(p.input.id)}.html)` } }
    })
    return cut ? { ...m, content } : m
  })
}
