import { useId, useState } from 'react'
import { BUDGETS, type Budget, DEFAULT_BUDGET, dollars } from '../shared/settings'
import type { Gate, SettingsChange } from './api'
import type { Target } from './More'
import { GROUP, LEGEND, OFF, ON, SEGMENT, tile } from './ui'

const GATES: { value: Gate; label: string; about: string }[] = [
  {
    value: 'step',
    label: 'After each step',
    about:
      'Before each step of the plan it gives you that step’s contract and waits for your Go. The most control, and a question between every step.',
  },
  {
    value: 'plan',
    label: 'Once, for the whole plan',
    about:
      'You approve the list of steps, then it builds them all without stopping, unless it has a real question.',
  },
]

/**
 * More › Harness: how the builder works through a build — when it stops for the person (the
 * gate), whether it proposes a design before building, and what one message may spend. Stored in project.json and read at
 * the start of each turn; tool results are what tell the model (server/plan.ts, gateOf), never
 * the system prompt. On the start page, the same choices for the project about to be made.
 *
 * Each choice is held here as well as in the target, whose project only refetches once the
 * PATCH has returned: a control bound to the prop alone snapped back until then.
 */
export default function Harness({ target }: { target: Target }) {
  const name = useId()
  const [gate, setGate] = useState<Gate>(target.settings.gate ?? 'step')
  const [design, setDesign] = useState(target.settings.design ?? false)
  const [budget, setBudget] = useState<Budget>(target.settings.budget ?? DEFAULT_BUDGET)
  const [error, setError] = useState<{ at: keyof SettingsChange; text: string } | null>(null)

  /** Shown at once, sent, and put back if refused. */
  const save = async (change: SettingsChange, undo: () => void) => {
    setError(null)
    try {
      await target.save(change)
    } catch (e) {
      undo()
      setError({ at: Object.keys(change)[0] as keyof SettingsChange, text: (e as Error).message })
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-6 text-sm md:px-8 md:py-8">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Harness</h2>
        <p className="opacity-60">
          {target.kind === 'draft'
            ? 'How the builder will work through the new project. It starts with these.'
            : 'How the builder works through a build in this project. Changes save as you make them.'}
        </p>
      </div>
      {target.busy && (
        <p className="rounded-md bg-current/5 p-2.5 text-sm opacity-70">
          A turn is running. Changes apply from the next message.
        </p>
      )}
      <fieldset className="space-y-2">
        <legend className={`mb-2 ${LEGEND}`}>When it stops for you</legend>
        {GATES.map((g) => (
          <label
            key={g.value}
            className={tile(gate === g.value)}
          >
            <input
              type="radio"
              name={name}
              checked={gate === g.value}
              onChange={() => {
                const was = gate
                setGate(g.value)
                void save({ gate: g.value }, () => setGate(was))
              }}
              className="mt-0.5 size-4 shrink-0 accent-blue-600"
            />
            <span className="min-w-0">
              <span className="block text-base md:text-sm font-medium">{g.label}</span>
              <span className="block opacity-60">{g.about}</span>
            </span>
          </label>
        ))}
        <Problem at="gate" error={error} />
      </fieldset>
      <fieldset className="space-y-2">
        <legend className={`mb-2 ${LEGEND}`}>Design</legend>
        <label
          className={tile(design)}
        >
          <input
            type="checkbox"
            role="switch"
            checked={design}
            onChange={() => {
              const next = !design
              setDesign(next)
              void save({ design: next }, () => setDesign(!next))
            }}
            className="mt-0.5 size-4 shrink-0 accent-blue-600"
          />
          <span className="min-w-0">
            <span className="block text-base md:text-sm font-medium">Propose a design first</span>
            <span className="block opacity-60">
              Before it builds a new app, it asks about the look you want, shows you three designs to pick from, and
              writes the one you pick up as a DESIGN.md in Artefacts for you to approve.
            </span>
          </span>
        </label>
        <Problem at="design" error={error} />
      </fieldset>
      <fieldset className="space-y-2">
        <legend className={`mb-2 ${LEGEND}`}>Spend per message</legend>
        <div className={`${GROUP} flex flex-wrap w-fit`} role="group" aria-label="spend per message">
          {BUDGETS.map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={budget === b}
              onClick={() => {
                const was = budget
                setBudget(b)
                void save({ budget: b }, () => setBudget(was))
              }}
              className={`${SEGMENT} tabular-nums ${budget === b ? ON : OFF}`}
            >
              {dollars(b)}
              {b === DEFAULT_BUDGET ? ' (default)' : ''}
            </button>
          ))}
        </div>
        <p className="opacity-60">
          Once a message has cost this much, the builder stops where it is and says so; “continue” gives it as much
          again. On GLM, {dollars(DEFAULT_BUDGET)} is about a hundred steps; on Sonnet, about thirty.
        </p>
        <Problem at="budget" error={error} />
      </fieldset>
    </div>
  )
}

/** Why a setting was not saved, under the setting `at`: the panel holds one error, for whichever failed last. */
export function Problem({ at, error }: { at: string; error: { at: string; text: string } | null }) {
  return error?.at === at ? (
    <p role="alert" className="text-sm text-red-500">
      {error.text}
    </p>
  ) : null
}
