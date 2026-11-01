/**
 * A project's settings as More sets them — the model, its parameters, and how the harness runs
 * a build — and the one check a change to them goes through, wherever it comes from: a PATCH
 * to a project, the settings a create brings with it, and the start page's draft, which holds
 * them before there is a project to PATCH. So a draft is refused with the words the server
 * would use. No imports but params.ts, which has none: the client bundle pulls this file in.
 */
import { type Params, type Thinking, paramsPatch } from './params'

/**
 * When a build stops for the person: after each step of its plan, or once, to approve the
 * plan. Absent means 'step'. Told to the model by update_plan's result (plan.ts), never by
 * the system prompt, so switching it leaves the cached prefix alone.
 */
export type Gate = 'step' | 'plan'
export const isGate = (v: unknown): v is Gate => v === 'step' || v === 'plan'

/**
 * What one message may spend, in dollars, before the builder stops and says so (agent.ts,
 * spent). Absent means DEFAULT_BUDGET. Money, not a step count: a step on GLM costs about a
 * cent, one on Sonnet at xhigh six, so a count bought each model a very different build.
 */
export const BUDGETS = [0.5, 1, 2, 5] as const
export type Budget = (typeof BUDGETS)[number]
export const DEFAULT_BUDGET: Budget = 2
export const isBudget = (v: unknown): v is Budget => BUDGETS.includes(v as Budget)
/** A budget as the panel and the builder's note say it: $0.50, $2. */
export const dollars = (b: number) => (Number.isInteger(b) ? `$${b}` : `$${b.toFixed(2)}`)

/**
 * Absent keys are the defaults: the house model and describer, the model's own parameters,
 * gate 'step', no design proposal, DEFAULT_BUDGET. `lookModel` describes screenshots for a `model` that cannot
 * see images; `params` are the model's parameters (params.ts).
 */
export type Settings = {
  model?: string
  lookModel?: string
  params?: Params
  gate?: Gate
  /** Propose a design — questions, three examples, a DESIGN.md — before building a new app. */
  design?: boolean
  /** Spend per message, in dollars; absent is DEFAULT_BUDGET. */
  budget?: Budget
}

/**
 * A change, as the panel sends it. `params` is a change to the stored set, not a new set: a
 * value sets its key, null clears it, `params: null` clears them all, and a list for the
 * effort keeps the stored one only if it is on the list (see paramsPatch).
 */
export type SettingsChange = {
  model?: string
  lookModel?: string
  params?: Partial<Record<keyof Params, number | Thinking | Thinking[] | null>> | null
  gate?: Gate
  design?: boolean
  budget?: Budget
}

/**
 * `body`'s settings, checked, as a function of the settings they change: it returns the keys
 * to set, undefined where one goes back to its default. Null when the body holds none. Throws
 * an Error naming the first bad value before anything is applied, which is what lets a create
 * refuse before it makes a directory. Keys that are not settings — a PATCH's `name` — are left
 * to the caller.
 *
 * A function and not the new settings, because `params` is applied to what is stored when it
 * runs: on the server inside updateMeta's queue, in the draft inside a state update. Built
 * from a snapshot instead, a save still in flight had its change put back by the next.
 */
export function settingsPatch(body: unknown): ((current: Settings) => Settings) | null {
  if (body == null) return null
  if (typeof body !== 'object' || Array.isArray(body)) throw new Error('settings must be an object')
  const b = body as Record<string, unknown>
  const set: Settings = {}
  let changed = false
  for (const key of ['model', 'lookModel'] as const) {
    if (b[key] === undefined) continue
    if (typeof b[key] !== 'string') throw new Error(`${key} must be a string`)
    // Trimmed: a pasted id with a space after it is the same model. Empty is the default.
    set[key] = b[key].trim() || undefined
    changed = true
  }
  if (b.gate !== undefined) {
    if (!isGate(b.gate)) throw new Error('gate must be "step" or "plan"')
    set.gate = b.gate
    changed = true
  }
  if (b.design !== undefined) {
    if (typeof b.design !== 'boolean') throw new Error('design must be true or false')
    // Off is the default, so it is stored as absent, as a model set back to the house one is.
    set.design = b.design || undefined
    changed = true
  }
  if (b.budget !== undefined) {
    if (!isBudget(b.budget)) throw new Error(`budget must be one of ${BUDGETS.join(', ')}`)
    // The default is stored as absent, as design's off is.
    set.budget = b.budget === DEFAULT_BUDGET ? undefined : b.budget
    changed = true
  }
  const params = b.params === undefined ? undefined : paramsPatch(b.params)
  if (!changed && !params) return null
  return (current) => (params ? { ...set, params: params(current.params) } : set)
}
