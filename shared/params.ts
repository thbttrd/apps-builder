/**
 * A project's model parameters: what they are, what each one does, which values are
 * allowed, and how they go on the wire. Shared by the server, which validates and sends
 * them, and the settings panel, which explains them — one table, so the range the panel
 * offers is the range the server accepts. No imports: the client bundle pulls this file in
 * whole, like labels.ts.
 *
 * Keys are OpenRouter's own request-body names (snake_case), because that is how they are
 * sent: as `.chat(id, { extraBody })`, which @openrouter/ai-sdk-provider 3.1 spreads over
 * its own settings. One path for all of them — AI SDK 7's own `reasoning` option is dropped
 * by that provider without a warning, min_p/top_a/repetition_penalty have no SDK option at
 * all, and the provider's typed effort lacks 'max'. extraBody would overwrite `usage` and
 * `cache_control` just as readily, which is why only what cleanParams passes reaches it:
 * the PATCH runs it on the way into project.json, readMeta on the way out.
 *
 * An absent key is not sent, so the model's provider applies its own default. Sending the
 * "default" value explicitly is not the same thing (OpenRouter: it can change provider-side
 * cache keys), so the panel stores "unset", never a default.
 */

/** OpenRouter's effort scale, highest first. 'none' is the panel's "off". */
export const EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const
export type Effort = (typeof EFFORTS)[number]

/**
 * What Thinking stores: an effort, or 'on' — reasoning switched on with no effort named.
 * For a model whose reasoning is optional and off by default but that lists no efforts
 * (deepseek-v3.2, grok-4.20), 'on' is the only way to switch it on. Not in EFFORTS: it
 * is not a step on that scale.
 */
export type Thinking = Effort | 'on'

export const THINKING_ABOUT =
  'How much the model reasons before it writes or calls a tool. Higher: better plans on hard ' +
  'changes, but slower turns and more reasoning tokens, which are billed as output. Lower: ' +
  'faster and cheaper, more likely to miss something. Off skips reasoning. Changing it costs ' +
  'one uncached message, since the cached conversation was built at the old setting.'

export const WINDOW_ABOUT =
  'The most one reply may be, reasoning included, in tokens. OpenRouter only sends a request to ' +
  'providers that can write this much, so a larger window rules out the cheap providers with ' +
  'small limits, and a smaller one lets them back in. The default is the largest any provider ' +
  'of this model offers, kept to half its context so the conversation has the other half. A ' +
  'reply that reaches it is cut off, and the turn stops there.'

/** What the Thinking window offers below the model's own, largest first. */
export const WINDOWS = [512_000, 256_000, 128_000, 64_000, 32_000, 16_000]

/**
 * What goes out as max_tokens: the project's window, but never more than the model's (`full`,
 * see windowOf in shared/models.ts) — a window chosen on one model outlives a switch to a smaller
 * one when it is set by hand — and the model's when the project sets none. Either unknown: the
 * other; both: nothing, and OpenRouter picks.
 */
export function sentWindow(chosen: number | undefined, full: number | undefined): number | undefined {
  return chosen && full ? Math.min(chosen, full) : (chosen ?? full)
}

export type Knob = {
  key: KnobKey
  label: string
  min: number
  max: number
  step: number
  int?: true
  /** What OpenRouter documents as the default when the model publishes none. */
  typical?: number
  about: string
}

export type KnobKey =
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'min_p'
  | 'top_a'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'repetition_penalty'
  | 'seed'

/** Every sampling parameter OpenRouter takes, in the order the panel shows them. */
export const KNOBS: Knob[] = [
  {
    key: 'temperature',
    label: 'Temperature',
    min: 0,
    max: 2,
    step: 0.05,
    typical: 1,
    about:
      'How random each next token is. Lower: steadier, more repeatable code — the same request ' +
      'gets much the same answer. Higher: more varied wording and ideas, and more mistakes. ' +
      'Near 0 it always takes the likeliest token.',
  },
  {
    key: 'top_p',
    label: 'Top-p',
    min: 0,
    max: 1,
    step: 0.01,
    typical: 1,
    about:
      'Keeps only the likeliest tokens whose probabilities add up to this share. Lower cuts the ' +
      'unlikely tail: safer, blander output. 1 keeps every token. Tune this or temperature, ' +
      'rarely both.',
  },
  {
    key: 'top_k',
    label: 'Top-k',
    min: 0,
    max: 1000,
    step: 1,
    int: true,
    typical: 0,
    about:
      'Picks only among the k likeliest tokens. Lower is more predictable; 1 always takes the ' +
      'single likeliest token. 0 turns the limit off.',
  },
  {
    key: 'min_p',
    label: 'Min-p',
    min: 0,
    max: 1,
    step: 0.01,
    typical: 0,
    about:
      'Drops any token less likely than this fraction of the likeliest one. Raising it prunes ' +
      'nonsense while still allowing variety, which lets a higher temperature stay coherent. ' +
      '0 turns it off.',
  },
  {
    key: 'top_a',
    label: 'Top-a',
    min: 0,
    max: 1,
    step: 0.01,
    typical: 0,
    about:
      'Like min-p, but the cutoff grows with the square of the likeliest token’s probability: ' +
      'strict when the model is sure, loose when it is not. Higher narrows the choice. 0 turns ' +
      'it off.',
  },
  {
    key: 'frequency_penalty',
    label: 'Frequency penalty',
    min: -2,
    max: 2,
    step: 0.05,
    typical: 0,
    about:
      'Penalises a token more each time it has already appeared. Positive: fewer repeated words ' +
      'and lines — but code repeats its identifiers on purpose, so high values can break it. ' +
      'Negative encourages repetition.',
  },
  {
    key: 'presence_penalty',
    label: 'Presence penalty',
    min: -2,
    max: 2,
    step: 0.05,
    typical: 0,
    about:
      'Penalises any token that has appeared at all, however often. Positive nudges toward new ' +
      'names and topics; negative toward staying with what has been said.',
  },
  {
    key: 'repetition_penalty',
    label: 'Repetition penalty',
    // Not 0: a seen token's positive logit is divided by it, and vLLM and HF transformers
    // both refuse anything that is not above zero.
    min: 0.01,
    max: 2,
    step: 0.01,
    typical: 1,
    about:
      'Scales down tokens already in the prompt or the answer. 1 is off; above 1 repeats less ' +
      '(1.1 is mild), below 1 repeats more. High values make the model avoid names it has to reuse.',
  },
  {
    key: 'seed',
    label: 'Seed',
    min: 0,
    max: 2147483647,
    step: 1,
    int: true,
    about:
      'Fixes the random draw, so the same request gets the same answer — on providers that ' +
      'honour it. Another number gives another, equally repeatable, answer. Empty: a new draw ' +
      'every time.',
  },
]

/** `max_tokens` is the Thinking window; it goes out as the provider's maxTokens, not in the body. */
export type Params = { effort?: Thinking; max_tokens?: number } & Partial<Record<KnobKey, number>>

/**
 * Validate a params object from outside. Throws a sentence naming the first problem.
 * Unknown keys are refused rather than dropped: whatever passes here goes into the body.
 */
export function cleanParams(input: unknown): Params {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('params must be an object')
  }
  const out: Params = {}
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue
    if (k === 'effort') {
      if (v !== 'on' && !EFFORTS.includes(v as Effort)) throw new Error(`effort must be on or one of ${EFFORTS.join(', ')}`)
      out.effort = v as Thinking
      continue
    }
    if (k === 'max_tokens') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1_000 || v > 10_000_000) {
        throw new Error('Thinking window must be a whole number of tokens from 1,000 to 10,000,000')
      }
      out.max_tokens = v
      continue
    }
    const knob = KNOBS.find((x) => x.key === k)
    if (!knob) throw new Error(`unknown parameter "${k}"`)
    if (typeof v !== 'number' || !Number.isFinite(v) || v < knob.min || v > knob.max || (knob.int && !Number.isInteger(v))) {
      throw new Error(`${knob.label} must be ${knob.int ? 'a whole number' : 'a number'} from ${knob.min} to ${knob.max}`)
    }
    out[knob.key] = v
  }
  return out
}

/**
 * Validate a PATCH's `params`, which is a change to the stored set, not a new one: a value
 * sets its key, null clears it, and `params: null` clears them all. Throws like cleanParams,
 * before anything is written. Returned as a function of the stored set so updateMeta can
 * apply it to whatever the write before it left: two saves of different keys in flight at
 * once both land, in either order. A whole set built by the client from what it last
 * fetched put the other save's key back the way it was.
 *
 * A list for the effort keeps the stored one only if it is on the list: a model switch sends
 * the efforts the new model takes. Decided here, on what the saves before it left, because
 * the panel's own idea of the effort can be a save behind, or one that failed: a switch that
 * named it put back an effort clicked away from, and stored an off that had been refused.
 */
export function paramsPatch(input: unknown): (stored?: Params) => Params | undefined {
  if (input === null) return () => undefined
  const effort = (input as { effort?: unknown } | undefined)?.effort
  const keep = Array.isArray(effort) ? effort : undefined
  for (const e of keep ?? []) cleanParams({ effort: e })
  const set = cleanParams(keep ? { ...(input as object), effort: null } : input)
  return (stored) => {
    const out: Params = { ...stored, ...set }
    for (const [k, v] of Object.entries(input as object)) if (v === null) delete out[k as keyof Params]
    if (keep && !keep.includes(out.effort)) delete out.effort
    return out
  }
}

/**
 * The effort a step of the plan is built at, or undefined for "as planned". Planning keeps the
 * project's Thinking; building a step it planned needs less, and every token of it is output
 * and time — Sonnet at xhigh thought for 65,536 tokens over one step and wrote nothing
 * (the design log › Small steps, and effort by phase). So: the lowest effort the model offers that
 * is still medium or above and below `planned` — Sonnet's xhigh or high builds at medium,
 * GLM's max at high, since it offers no medium and its low is below it. Never raised, and a
 * planned effort of medium or less, 'on', off or unknown is left alone. `planned` is the
 * project's effort, or the model's default when it has none; `offered`, the model's efforts
 * from the catalog.
 */
export function buildEffort(planned: string | undefined, offered: readonly string[]): Effort | undefined {
  const rank = (e: string) => EFFORTS.indexOf(e as Effort)
  const from = rank(planned ?? '')
  if (from < 0) return undefined
  const lower = offered.filter((e) => rank(e) > from && rank(e) <= rank('medium'))
  return lower.sort((a, b) => rank(a) - rank(b)).at(-1) as Effort | undefined
}

/** The request-body keys for these params — only the ones that are set. The Thinking window is
 *  not one: it is the provider's maxTokens (loopModel), which the body would overwrite. */
export function requestBody(p: Params): Record<string, unknown> {
  const { effort, max_tokens: _window, ...knobs } = p
  return {
    ...knobs,
    // `enabled: true` beside the effort, because on models whose reasoning is off by
    // default (Claude Opus 4.7/4.8) an effort alone does not switch it on.
    ...(effort && {
      reasoning: effort === 'none' ? { enabled: false } : effort === 'on' ? { enabled: true } : { enabled: true, effort },
    }),
  }
}
