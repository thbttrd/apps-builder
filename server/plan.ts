/**
 * The spec and the plan the model saves, and the gate that holds a build for the person: what
 * update_plan answers, the plan a question shows, the effort a step is built at, and what stops
 * a turn that writes through a hold.
 */
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import { isAsk } from '../shared/ask'
import type { Effort } from '../shared/params'
import type { Gate } from '../shared/settings'

/**
 * What the app is for, as the model last saved it with save_spec, for the Artefacts pane.
 * Under .apps-builder/, so every checkpoint commits it and a restore puts back the spec
 * that went with that code. Each save replaces the last: it is a statement of now, and the
 * history pane already keeps the old ones.
 */
export const SPEC = z.object({
  summary: z.string().describe('what the app is, in one or two sentences'),
  personas: z
    .array(
      z.object({
        name: z.string().describe('who, in two or three words, e.g. "Busy parent"'),
        goal: z.string().describe('what they want to get done with the app, in one sentence'),
      }),
    )
    .min(1),
  design: z.string().describe('how it looks — colours, type, mood — in a sentence or two'),
  // Three fields, not a sentence in `design`: that sentence described a desktop and a phone,
  // and the tablet got the phone's layout stretched (a feed reader, 2026-09-26). Absent from
  // a spec saved before them, which the Artefacts pane allows for.
  layouts: z
    .object({
      phone: z.string().describe('under 768px: how the main screen is arranged and how you move around it'),
      tablet: z.string().describe('768px and up: what now sits side by side that the phone stacks'),
      desktop: z.string().describe('1024px and up: how it uses the width — sidebar, columns, panels'),
    })
    .describe('the main screen on each device, each its own arrangement — never the phone one stretched'),
  screens: z
    .array(z.object({ name: z.string(), purpose: z.string().describe('what the person does there') }))
    .min(1),
  edgeCases: z.array(z.string()).describe('each case the app must handle: empty states, bad input, limits'),
})
export type Spec = z.infer<typeof SPEC>
/** A spec as read back: one saved before `layouts` existed (2026-09-26) has none, which the Artefacts pane allows for. */
export const SAVED_SPEC = SPEC.partial({ layouts: true })
export type SavedSpec = z.infer<typeof SAVED_SPEC>

/** The steps of the build, as the model last saved them with update_plan. Kept as the spec is. */
export const PLAN = z.object({
  steps: z
    .array(
      z.object({
        title: z.string().describe('the step, in a few words'),
        contract: z
          .string()
          .describe('what it does, what changes, and how you will check it, in two or three sentences'),
        status: z.enum(['pending', 'doing', 'done']),
      }),
    )
    .min(1),
})
export type Plan = z.infer<typeof PLAN>
/** The plan as a question carries it (ask_user): `next` is the step the question asks to build. */
export type AskedPlan = Plan & { next?: number }

/**
 * update_plan's result: what the model does next, by the project's gate — and whether the
 * build is now held for the person. The gate lives here and not in the system prompt, so
 * switching it never changes the cached prefix, and it arrives as the step it governs ends,
 * which is where a small model follows it.
 *
 * A new plan goes to the person under both gates: one with nothing started, or one whose
 * steps' titles or count differ from the last — a first plan sent with step 1 already doing,
 * a feature appended to a finished plan, a step renamed at the person's word. Titles, not
 * contracts: GLM rewords a contract under the same title mid-build (plants runs, 2026-09-26),
 * and that is no new plan. 'step' also stops each time a step is newly done, on
 * the next one; 'plan' does not stop again. A finish stops too when it is past
 * something the person never saw: a plan new or grown, under both gates, and under 'step'
 * more than one step done in one update. Otherwise the model is told to build
 * the one step in hand and report it done before the next: told only "carry on", GLM marked
 * step 1 doing and then wrote three steps' files over ten minutes without another word to
 * the plan (measured 2026-09-26), and the Artefacts pane said "step 1" all along.
 */
/**
 * What each question gateOf asks for is told first. The chat draws the plan above the question
 * (ask_user), so the question is one sentence: GLM wrote a three-step plan with its contracts
 * into one, and the answer, which repeats its question, filled the person's bubble with it
 * (specs/chat-improvement, 2026-10-06).
 */
const SHOWN = 'The person sees the plan above your question, every step with its contract, so do not repeat it there.'

export function gateOf(gate: Gate, was: Plan | null, now: Plan): { hold: boolean; say: string } {
  const done = (p: Plan | null) => p?.steps.filter((s) => s.status === 'done').length ?? 0
  const i = stepAt(now)
  const next = now.steps[i]
  if (!next) {
    // A finish on a plan the person has not seen — new, or grown since — holds under both
    // gates, and under 'step' so does one with more than one step done in one update: each was
    // built past a step no one said go to (seen 2026-09-30). A step renamed is neither.
    const unseen = !was || now.steps.length > was.steps.length
    if (unseen || (gate === 'step' && done(now) - done(was) > 1)) {
      return {
        hold: true,
        say:
          `Plan saved, and every step is done — but not all of it was put to the person first, so ` +
          `nothing more can be written until they answer. Check the app once more with check_app; ` +
          `if it finds a problem, say so in the question, and the fix waits for their answer. Then ` +
          `call ask_user. ${SHOWN} Say in one sentence what was built, and ask whether it is what ` +
          `they wanted, with the options "Looks right" (recommended) and "Change it".`,
      }
    }
    return { hold: false, say: 'Plan saved, and every step is done. Check the app once more, then tell the person what you built.' }
  }
  const ask = (what: string) => ({
    hold: true,
    say: `Plan saved. Stop here: call ask_user now. Nothing more can be written until they answer. ${what}`,
  })
  const changed =
    !was || was.steps.length !== now.steps.length || now.steps.some((s, k) => s.title !== was.steps[k]!.title)
  if (changed || now.steps.every((s) => s.status === 'pending')) {
    return gate === 'step'
      ? ask(
          `${SHOWN} Ask in one sentence whether to build step ${i + 1}, "${next.title}", with the ` +
            `options "Go" (recommended) and "Change it".`,
        )
      : ask(
          `${SHOWN} Ask in one sentence whether to build the plan as it stands, with the options ` +
            `"Build it" (recommended) and "Change the plan". Once they say build it, work through ` +
            `every step without stopping to ask again.`,
        )
  }
  if (gate === 'step' && done(now) > done(was)) {
    return ask(
      `A step just finished. ${SHOWN} Say in one sentence what it did, then ask whether to ` +
        `build step ${i + 1}, "${next.title}", with the options "Go" (recommended) and "Change it".`,
    )
  }
  const after = i + 1 < now.steps.length ? ` before you write any file for step ${i + 2}` : ''
  return {
    hold: false,
    say:
      `Plan saved. Build step ${i + 1}, "${next.title}", and nothing past it. Check it with ` +
      `check_app, then send update_plan with it marked done${after}.`,
  }
}

/**
 * The plan as the question that holds it shows it. Nothing runs while the question is open, so
 * a step saved as doing — GLM and Sonnet both send a first plan with step 1 doing — is shown not
 * started: drawn in progress and framed, it read as the one step being approved, under a
 * question about the whole plan (specs/chat-improvement, feedback-1). Under 'step' the question
 * is about one step, the first not done, and `next` marks it; under 'plan', and on a finished
 * plan, none is.
 */
export function askedPlan(gate: Gate, plan: Plan): AskedPlan {
  const steps = plan.steps.map((s) => (s.status === 'doing' ? { ...s, status: 'pending' as const } : s))
  const next = gate === 'step' ? stepAt(plan) : -1
  return next >= 0 ? { steps, next } : { steps }
}

/**
 * The step a plan is at: the one doing, else the first not done, else -1. gateOf names it in
 * the question and askedPlan() frames it, so the card frames the step the question is about even
 * on a plan with a step done out of order (review of #46).
 */
function stepAt(plan: Plan): number {
  const doing = plan.steps.findIndex((s) => s.status === 'doing')
  return doing >= 0 ? doing : plan.steps.findIndex((s) => s.status !== 'done')
}

/** What write_file and delete_file answer while the plan is held for the person. */
export const HELD =
  'Not written: the plan is waiting for the person. Call ask_user now, as update_plan said; ' +
  'write this after they answer.'

/** Whether a turn's last step asked the person a question: a turn that did ended for that. */
export function endsOnAsk(steps: readonly { toolCalls: readonly { toolName: string }[] }[]): boolean {
  return steps.at(-1)?.toolCalls.some((c) => isAsk(c.toolName)) ?? false
}

type Refused = { toolResults: readonly { output: unknown }[] }
const heldSteps = (steps: readonly Refused[]) => steps.filter((s) => s.toolResults.some((r) => r.output === HELD)).length

/**
 * A stop condition: the plan is held for the person and a second step wrote anyway. The first
 * can be the message that set the hold, whose writes were already on their way; by the second
 * the model has read "stop". Without it, a model that ignored HELD wrote on — refused each
 * time, at full price — to the end of its budget.
 */
export const heldAgain = ({ steps }: { steps: readonly Refused[] }) => heldSteps(steps) >= 2

/** The note for a turn heldAgain stopped, or null — none when its last step asked after all. */
export function heldStopNote(steps: readonly (Refused & { toolCalls: readonly { toolName: string }[] })[]): string | null {
  if (heldSteps(steps) < 2 || endsOnAsk(steps)) return null
  return '⚠ The plan is waiting for your go and the builder kept writing instead of asking, so the turn stopped. Say “go”, or what to change, and it carries on.'
}

export type Hold = { was: Plan | null; held: boolean }

/**
 * streamText's prepareStep: before each request, the build effort while the plan has a step not
 * yet done, else the project's own — the model thinks hard about what to build, then builds it
 * at less (see buildEffort). Read off `plan.was`, which update_plan moves, so a turn changes
 * over as soon as a plan is saved, and stays there to its end; the next turn goes back.
 *
 * Changing the effort re-reads the cached conversation once (the design log › Model settings panel),
 * and this changes it twice a plan — when building starts and at the first turn after it ends —
 * not every step: a gated build's turns are all mid-plan. Going back within the turn bought
 * nothing: its closing summary re-read the conversation uncached (Trace, 2026-09-30, ~$0.03 on
 * GLM). The next turn's first request pays it instead, unless the cache has lapsed by then
 * anyway, as it has once the person has looked at the app. Known limit: re-planning mid-build,
 * at the person's word, happens at the build effort, since the plan still has steps to do.
 */
export function effortStep(plan: Hold, build: Effort | undefined, at: (effort: Effort) => LanguageModel) {
  let building: LanguageModel | undefined
  return () => {
    if (!building && build && plan.was?.steps.some((s) => s.status !== 'done')) building = at(build)
    return building ? { model: building } : {}
  }
}
