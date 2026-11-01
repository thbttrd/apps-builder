import { useId, useLayoutEffect, useRef, useState } from 'react'
import { type Question, answerOf } from '../shared/ask'
import Swatches from './Swatches'
import { CARD, chip, tile } from './ui'

/**
 * The questions a turn ended on (shared/ask.ts), one at a time, as Claude Code asks them: a
 * step per question, named by its header, then Review, which lists the picks above Send. All
 * at once, three questions of three described options took three screens at 390 px, and the
 * chat, which follows its bottom, opened on the last of them (measured 2026-09-25). One
 * question has no steps: its Send is right under it.
 *
 * Each question is a fieldset of native radios or checkboxes, so a screen reader hears the
 * question with each option. Picking a single choice with the pointer moves on to the next
 * step; changing it from the keyboard does not, because the arrow keys move through a radio
 * group by selecting, and moving on at the first arrow would skip the rest of it. Enter, or
 * Next, moves on from anywhere. Send is never disabled — an unpicked question goes as "no
 * preference" — so no refusal can drop the focus.
 */
export default function Ask({
  questions,
  onAnswer,
  grew,
}: {
  questions: Question[]
  onAnswer: (text: string) => void
  /** The chat's: keeps it at its bottom, if it was there, when a step changes the height. */
  grew: () => void
}) {
  const name = useId()
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []))
  const stepped = questions.length > 1
  const [at, setAt] = useState(0)
  const done = !stepped || at === questions.length
  const form = useRef<HTMLFormElement>(null)
  // Whether the last thing that happened in the card was the pointer, not a key.
  const pointer = useRef(false)
  const moved = useRef(false)

  const go = (step: number) => {
    moved.current = true
    setAt(Math.min(step, questions.length))
  }
  const pick = (i: number, label: string, multi: boolean) =>
    setPicks((all) =>
      all.map((was, j) =>
        j !== i ? was : !multi ? [label] : was.includes(label) ? was.filter((l) => l !== label) : [...was, label],
      ),
    )

  // A step's inputs replace the last one's, so a pick that moved on took the focus with it,
  // onto <body>. It goes to what took their place. A step picked by its name keeps the focus
  // on that name. Not on mount: a card arriving must not pull the focus out of the composer.
  useLayoutEffect(() => {
    if (!moved.current) return
    if (!form.current?.contains(document.activeElement)) {
      form.current?.querySelector<HTMLElement>('fieldset input, button[type=submit]')?.focus()
    }
    grew()
  }, [at, grew])

  const q = questions[at]
  return (
    <form
      ref={form}
      className={CARD}
      onPointerDown={() => (pointer.current = true)}
      onKeyDown={() => (pointer.current = false)}
      onSubmit={(e) => {
        e.preventDefault()
        if (done) onAnswer(answerOf(questions, picks))
        else go(at + 1)
      }}
    >
      {stepped && (
        <nav aria-label="questions" className="flex flex-wrap gap-1.5">
          {[...questions.map((x, i) => x.header || `Question ${i + 1}`), 'Review'].map((label, i) => (
            <button
              key={i}
              type="button"
              aria-current={i === at ? 'step' : undefined}
              onClick={() => go(i)}
              className={chip(i === at)}
            >
              {picks[i]?.length ? <span aria-hidden="true">✓ </span> : null}
              {label}
              {picks[i]?.length ? <span className="sr-only">, answered</span> : null}
            </button>
          ))}
        </nav>
      )}

      {q ? (
        // Keyed by the step, so its inputs are new ones and not the last step's, relabelled.
        <fieldset key={at} className="space-y-2">
          {/* Its own line breaks kept: a model that writes a list into the question still gets one. */}
          <legend className="mb-2 text-base leading-snug whitespace-pre-line">
            {!stepped && q.header && (
              <span className="mr-2 whitespace-nowrap rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                {q.header}
              </span>
            )}
            {q.question}
            {q.multiSelect && <span className="text-sm opacity-60"> · pick any</span>}
          </legend>
          {q.options.map((o, k) => {
            const on = picks[at]?.includes(o.label) ?? false
            return (
              <label
                key={k}
                className={tile(on)}
              >
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`${name}-${at}`}
                  checked={on}
                  onChange={() => {
                    pick(at, o.label, q.multiSelect)
                    if (stepped && !q.multiSelect && pointer.current) go(at + 1)
                  }}
                  className="mt-1 size-4 shrink-0 accent-blue-600"
                />
                <span className="min-w-0 wrap-anywhere">
                  <span className="block">{o.label}</span>
                  {/* A design's palette, for ask_design's inspirations. */}
                  {o.swatches && <Swatches colors={o.swatches} className="my-1" />}
                  {o.description && <span className="block text-sm opacity-60">{o.description}</span>}
                </span>
              </label>
            )
          })}
        </fieldset>
      ) : (
        <dl className="space-y-2.5">
          {questions.map((x, i) => (
            <div key={i}>
              <dt className="text-sm opacity-60">{x.question}</dt>
              <dd className="wrap-anywhere">{picks[i]?.length ? picks[i].join(', ') : 'No preference — the builder decides'}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm opacity-60">Or type your own answer below.</p>
        <button
          type="submit"
          className={`min-h-11 rounded-full px-4 text-sm font-medium md:min-h-9 ${
            done ? 'bg-ink text-paper' : 'border border-current/25 hover:border-current/50'
          }`}
        >
          {done ? 'Send answers' : 'Next'}
        </button>
      </div>
    </form>
  )
}
