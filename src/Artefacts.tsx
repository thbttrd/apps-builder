import type { DesignBrief, ExampleId, Plan } from './api'
import { DesignDoc } from './DesignDoc'
import { DesignViewer, Section, useArtefacts } from './Designs'
import Swatches from './Swatches'
import { LABEL } from './ui'

/**
 * What the builder has written down about the app: its spec and its build plan, as it last
 * saved them with save_spec and update_plan, and the design brief the person answered
 * (server/design.ts). Read-only — the way to change either is to say
 * so in the chat, which is also what gets the app changed to match.
 *
 * The plan goes above the spec once it exists. Refetched as the build goes (useArtefacts).
 */
export default function Artefacts({
  slug,
  viewing,
  onViewing,
  readTimes,
  onSend,
}: {
  slug: string
  /** The design example the chat's View asked for. */
  viewing: ExampleId | null
  onViewing: (id: ExampleId) => void
  /** Bumped by the chat's Read it: DESIGN.md is brought into view. */
  readTimes: number
  /** Sends a chat message: a pick starts the build with one. */
  onSend: (text: string) => void
}) {
  const { saved, error, setExamples } = useArtefacts(slug)
  const spec = saved?.spec
  const plan = saved?.plan
  const design = saved?.design ?? null
  const examples = saved?.examples ?? null
  return (
    <div className="@container flex-1 min-h-0 overflow-y-auto p-3 md:p-4">
      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
      {!saved ? null : !spec && !plan && !design ? (
        <p className="h-full grid place-items-center px-6 text-center text-sm opacity-50">
          No spec yet. Describe an app in the chat — the builder writes its spec here once its
          questions are answered, then the steps it builds it in.
        </p>
      ) : (
        <article className="mx-auto max-w-3xl space-y-6 rounded-xl border border-current/10 bg-paper p-4 md:p-6">
          {/* The plan first once there is one: during a build it is what moves, and under a
              spec of eight edge cases it was a scroll away on a 900 px screen. */}
          {plan && <Steps plan={plan} />}
          {/* DESIGN.md next: while the person reads it there is no plan yet, so it is on top;
              once approved it is what the build is held to. */}
          {examples?.doc && (
            <DesignDoc
              slug={slug}
              view={examples}
              readTimes={readTimes}
              onSend={onSend}
              onChanged={setExamples}
            />
          )}
          {/* The examples above the brief they came from: while the person picks, they are
              what the pane is for. */}
          {examples && (
            <DesignViewer
              slug={slug}
              view={examples}
              viewing={viewing}
              onViewing={onViewing}
              onSend={onSend}
              onPicked={setExamples}
            />
          )}
          {design && <Brief design={design} />}
          {spec && (
            <>
              <header className="space-y-2">
                <h2 className="text-lg font-semibold">Spec</h2>
                <p className="text-base leading-relaxed wrap-anywhere">{spec.summary}</p>
              </header>
              <Section title="Who it is for">
                <ul className="grid gap-2 @xl:grid-cols-2">
                  {spec.personas.map((p, i) => (
                    <li key={i} className="rounded-lg border border-current/10 bg-current/[0.03] px-3 py-2.5 wrap-anywhere">
                      <p className="font-medium">{p.name}</p>
                      <p className="text-sm opacity-70">{p.goal}</p>
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Design">
                <p className="leading-relaxed wrap-anywhere">{spec.design}</p>
                {spec.layouts && (
                  <ul className="grid gap-2 @xl:grid-cols-3">
                    {(['phone', 'tablet', 'desktop'] as const).map((d) => (
                      <li key={d} className="rounded-lg border border-current/10 bg-current/[0.03] px-3 py-2.5 wrap-anywhere">
                        <p className="font-medium capitalize">{d}</p>
                        <p className="text-sm opacity-70">{spec.layouts?.[d]}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
              <Section title="Screens">
                <ul className="space-y-2">
                  {spec.screens.map((s, i) => (
                    <li key={i} className="wrap-anywhere">
                      <span className="font-medium">{s.name}</span>
                      <span className="opacity-70"> — {s.purpose}</span>
                    </li>
                  ))}
                </ul>
              </Section>
              {spec.edgeCases.length > 0 && (
                <Section title="Edge cases">
                  <ul className="list-disc space-y-1 pl-5 wrap-anywhere">
                    {spec.edgeCases.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </Section>
              )}
            </>
          )}
        </article>
      )}
    </div>
  )
}

/** The person's answers to the design questions: a card a pick, then the catalog design
 *  they chose, with its colours. An answer typed instead of picked is shown as it was sent. */
function Brief({ design: { brief, inspiration } }: { design: DesignBrief }) {
  const picks = Object.entries(brief.picks).filter(([header]) => header !== 'Inspiration')
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">Design brief</h2>
      {picks.length > 0 ? (
        <dl className="grid gap-2 @md:grid-cols-3">
          {picks.map(([header, pick]) => (
            <div key={header} className="rounded-lg border border-current/10 bg-current/[0.03] px-3 py-2.5 wrap-anywhere">
              <dt className={LABEL}>{header}</dt>
              <dd>{pick}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="whitespace-pre-line leading-relaxed wrap-anywhere">{brief.answer}</p>
      )}
      {inspiration && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-current/10 px-3 py-2.5">
          <Swatches colors={inspiration.swatches} />
          <div className="min-w-0 flex-1 basis-48 wrap-anywhere">
            <p className="font-medium">Inspired by {inspiration.name}</p>
            <p className="text-sm opacity-70">{inspiration.blurb}</p>
          </div>
        </div>
      )}
    </section>
  )
}

const MARK = {
  done: { glyph: '✓', said: 'done', tone: 'text-emerald-600 dark:text-emerald-400' },
  doing: { glyph: '◐', said: 'in progress', tone: 'text-blue-600 dark:text-blue-400' },
  pending: { glyph: '○', said: 'not started', tone: 'opacity-40' },
} as const

/** The plan, a row a step: its mark, its title and its contract. `current`, the step in
 *  progress unless said otherwise, is the page's current step, for a screen reader as for the
 *  eye. The chat draws it too, above a gate's question, framing the step that question asks
 *  about and none when it asks about the whole plan. */
export function Steps({
  plan,
  current = plan.steps.findIndex((s) => s.status === 'doing'),
}: {
  plan: Plan
  current?: number
}) {
  const done = plan.steps.filter((s) => s.status === 'done').length
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">
        Plan <span className="text-sm font-normal opacity-60">· {done} of {plan.steps.length} done</span>
      </h2>
      <ol className="space-y-2">
        {plan.steps.map((s, i) => {
          const m = MARK[s.status]
          return (
            <li
              key={i}
              aria-current={i === current ? 'step' : undefined}
              className={`flex gap-3 rounded-lg border px-3 py-2.5 wrap-anywhere ${
                i === current ? 'border-blue-500/40 bg-blue-500/[0.05]' : 'border-current/10'
              }`}
            >
              <span aria-hidden="true" className={`mt-px w-4 shrink-0 text-center ${m.tone}`}>
                {m.glyph}
              </span>
              <div className="min-w-0">
                {/* The status first, as the mark it stands for is first. */}
                <p className="font-medium">
                  <span className="sr-only">{m.said}: </span>
                  {i + 1}. {s.title}
                </p>
                <p className="text-sm opacity-70">{s.contract}</p>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
