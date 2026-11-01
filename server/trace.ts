/**
 * `.apps-builder/trace.jsonl`: what the builder did, request by request, for finding out later
 * what works and what does not — one JSON line per model request (`step`), per screenshot
 * described (`look`) and per turn that reached its end (`turn`).
 *
 * chat.json has the words, but not the numbers: no step's cost, tokens, time, provider or
 * effort was kept, only a project's total, and the figures in the design log came from logs added by
 * hand and thrown away. And chat.json is rewound by a code+chat restore; this file is not.
 * Appended, never rewritten, and never committed (see UNCOMMITTED in git.ts), so a
 * restore leaves it alone. A `turn` line names its checkpoint, whose chat.json holds that
 * turn's full conversation — reasoning included.
 *
 * Every line carries `run`, one id per turn: a turn killed mid-way (a restart) leaves step
 * lines and no `turn` line, and the next one reuses its number.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const TRACE = join('.apps-builder', 'trace.jsonl')

/** The parts of a StepResult (ai) a line reads; the real one is wider. */
type TracedStep = {
  finishReason: string
  usage: {
    inputTokens?: number
    outputTokens?: number
    inputTokenDetails: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails: { reasoningTokens?: number }
  }
  providerMetadata?: Record<string, unknown>
  response: { id: string; modelId: string }
  performance: { stepTimeMs: number; responseTimeMs: number; timeToFirstOutputMs?: number; toolExecutionMs: Readonly<Record<string, number>> }
  toolCalls: readonly { toolCallId: string; toolName: string; input: unknown }[]
  toolResults: readonly { toolCallId: string; output: unknown }[]
  content: readonly { type: string; toolCallId?: string }[]
}

type Tool = { name: string; path?: string; ms?: number; refused?: true; error?: true; flags?: string[] }

/** The same for every line of one turn. */
export type Run = { run: string; turn: number }

/**
 * A tool's answer that said no. ponytail: read off the wording the tools answer with —
 * "Not written…", "Plan not saved…", "no such file…", "path must start with…" — so a refusal
 * worded otherwise (a design example's check) counts as done; add its words here when that
 * matters.
 */
const refused = (out: unknown) => typeof out === 'string' && /^(Not |Plan not saved|no such file|path must start with)/.test(out)

/**
 * What check_app's report found, by the lines it says them in (pilot.ts). Anchored to those
 * lines: the page's outline and the look's answer are the app's words, and may say anything.
 */
const FLAGS: [string, RegExp][] = [
  // Whatever tsc said when it exited non-zero, a missing tsc included; always the first line.
  ['type-error', /^typecheck: \n/],
  ['compile-error', /^COMPILE ERROR/m],
  ['runtime-error', /^errors:/m],
  ['crashed', /^APP CRASHED/m],
  ['horizontal-scroll', /^HORIZONTAL SCROLL/m],
  ['narrow', /^NARROW/m],
  ['off-design', /^OFF-DESIGN/m],
  ['direct-fetch', /^DIRECT FETCH/m],
  ['step-failed', /^\d+\. .* — FAILED: /m],
  ['no-look', /^could not look \(/m],
  ['no-typecheck', /^typecheck: could not be run/],
  ['no-preview', /^preview: (not running|could not be checked)/m],
]

/**
 * `clean` only when both halves ran and found nothing: the browser's "no errors" is its half
 * alone (pilot.ts inspect), and checkApp puts the typecheck in front of it.
 */
function flagsOf(report: string): string[] {
  const found = FLAGS.filter(([, re]) => re.test(report)).map(([f]) => f)
  return !found.length && /^typecheck: clean$/m.test(report) && /^no errors$/m.test(report) ? ['clean'] : found
}

/** What OpenRouter says a call cost, read off its provider metadata: 0 when it says nothing. */
export const usdOf = (meta: Record<string, unknown> | undefined): number =>
  (meta?.openrouter as { usage?: { cost?: number } } | undefined)?.usage?.cost ?? 0

/** One request, with how long it and each of its tools took, and what it cost. */
export function stepLine(s: TracedStep, at: Run & { step: number; model: string; effort?: string }) {
  const or = s.providerMetadata?.openrouter as { provider?: string; usage?: { cost?: number } } | undefined
  const results = new Map(s.toolResults.map((r) => [r.toolCallId, r.output]))
  // A call that threw, or whose input failed its schema or would not parse, has no result:
  // ai 7 keeps it as a `tool-error` part (stream.ts settles its row the same way).
  const failed = new Set(s.content.flatMap((p) => (p.type === 'tool-error' ? [p.toolCallId] : [])))
  const tools = s.toolCalls.map((c): Tool => {
    const out = results.get(c.toolCallId)
    const path = (c.input as { path?: unknown } | null)?.path
    return {
      name: c.toolName,
      ...(typeof path === 'string' ? { path } : {}),
      ...(c.toolCallId in s.performance.toolExecutionMs ? { ms: Math.round(s.performance.toolExecutionMs[c.toolCallId]!) } : {}),
      ...(refused(out) ? { refused: true as const } : {}),
      ...(failed.has(c.toolCallId) ? { error: true as const } : {}),
      ...(c.toolName === 'check_app' && typeof out === 'string' ? { flags: flagsOf(out) } : {}),
    }
  })
  return {
    kind: 'step' as const,
    at: new Date().toISOString(),
    ...at,
    served: s.response.modelId,
    provider: or?.provider,
    // OpenRouter's generation id: GET /api/v1/generation?id= tells the rest.
    id: s.response.id,
    finish: s.finishReason,
    tokens: {
      input: s.usage.inputTokens,
      cacheRead: s.usage.inputTokenDetails.cacheReadTokens,
      cacheWrite: s.usage.inputTokenDetails.cacheWriteTokens,
      output: s.usage.outputTokens,
      reasoning: s.usage.outputTokenDetails.reasoningTokens,
    },
    usd: or?.usage?.cost,
    ms: {
      step: Math.round(s.performance.stepTimeMs),
      response: Math.round(s.performance.responseTimeMs),
      firstOutput: s.performance.timeToFirstOutputMs === undefined ? undefined : Math.round(s.performance.timeToFirstOutputMs),
    },
    tools,
  }
}

/** Appended to the project's trace. Never throws: a lost line is worth less than the turn. */
export async function trace(dir: string, line: object): Promise<void> {
  try {
    // A look can come before anything has made .apps-builder, in a project's first step.
    await mkdir(dirname(join(dir, TRACE)), { recursive: true })
    await appendFile(join(dir, TRACE), `${JSON.stringify(line)}\n`)
  } catch (e) {
    console.error(`[trace ${dir}]`, (e as Error).message)
  }
}
