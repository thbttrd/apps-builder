import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type ArtefactsView, type DesignView, type DocView, type ExampleId, api, json } from './api'
import { touched } from './chatStore'
import { useChat, useLatest, useRun } from './hooks'
import Swatches from './Swatches'
import { useTheme } from './theme'
import { CARD, GROUP, LABEL, OFF, ON, OUTLINE, PILL, chip } from './ui'

type Example = DesignView['examples'][number]

/**
 * What the builder has written down (GET /artefacts): the Artefacts pane draws all of it, the
 * chat the design examples and the phase they are in (server/design.ts). Refetched on the chat
 * store's `busy` and `writes`: a settled save bumps `writes`, so a pane left open follows the
 * build step by step, the picker comes as the examples' turn ends, and a restore bumps it too.
 * `undefined` until the first answer, so an empty state never flashes over a spec.
 * `setExamples` takes a design route's answer.
 */
export function useArtefacts(slug: string) {
  const [saved, setSaved] = useState<ArtefactsView>()
  const [error, setError] = useState<string | null>(null)
  const { busy, writes } = useChat(slug)
  useLatest(
    () => api<ArtefactsView>(`/api/projects/${slug}/artefacts`),
    [slug, busy, writes],
    (d) => {
      setSaved(d)
      setError(null)
    },
    (e) => setError(e.message),
  )
  const setExamples = useCallback((v: DesignView) => setSaved((s) => s && { ...s, examples: v }), [])
  return { saved, error, setExamples }
}

const page = (slug: string, e: Example) => `/api/projects/${slug}/designs/${e.id}?v=${encodeURIComponent(e.at ?? '')}`
const shot = (slug: string, e: Example, which: 'desktop' | 'phone', dark: boolean) =>
  `/api/projects/${slug}/designs/${e.id}/${which}${dark && e.dark ? '-dark' : ''}.jpg?v=${encodeURIComponent(e.at ?? '')}`

/** The pick, as the route takes it, then the message that starts the build: one path for both panes. */
export async function choose(slug: string, e: Example | null, send: (text: string) => void): Promise<DesignView> {
  const view = await json<DesignView>(`/api/projects/${slug}/designs/pick`, 'POST', { id: e?.id ?? null })
  touched(slug)
  send(e ? `Use design ${e.id}: ${e.name} (from ${e.fromName}).` : 'Build it without a design example.')
  return view
}

/**
 * The picker, at the end of the chat while the person chooses (phase 'pick'): each example that
 * passed as a picture of it on a desktop, with its phone one set in the corner, its name and
 * the design it came from, View and Use this one. One that was dropped is a line saying why,
 * so a missing C is never a mystery. None passed: try again, or build without.
 *
 * Its own card, not a question: code ends the examples' turn (stopWhen), and the pick is a
 * route, not a message — so nothing here is a tool call the next message could answer.
 */
export function DesignPicker({
  slug,
  view,
  onView,
  onSend,
  onPicked,
  grew,
}: {
  slug: string
  view: DesignView
  onView: (id: ExampleId) => void
  onSend: (text: string) => void
  onPicked: (v: DesignView) => void
  grew: () => void
}) {
  const { resolved } = useTheme()
  const { going, error, run } = useRun(onPicked)
  const passed = view.examples.filter((e) => e.status === 'passed')
  const dropped = view.examples.filter((e) => e.status === 'dropped')
  const go = (e: Example | null) => run(() => choose(slug, e, onSend))
  useLayoutEffect(() => grew(), [grew, error])

  return (
    <section aria-label="design examples" className={CARD}>
      <header>
        <h2 className="text-base font-medium">Pick a design</h2>
        <p className="text-sm opacity-60">
          {passed.length
            ? `${passed.length === 1 ? 'One example' : `${passed.length} examples`} of your app’s main screen, each in its own design. The one you use is what the app is built in.`
            : 'None of the examples passed the design check.'}
        </p>
      </header>
      {passed.length > 0 && (
        <ul className="grid gap-3 @lg:grid-cols-2 @3xl:grid-cols-3">
          {passed.map((e) => (
            <li key={e.id} className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-current/15 bg-paper">
              <button
                type="button"
                onClick={() => onView(e.id)}
                aria-label={`view design ${e.id}, ${e.name}, full size`}
                className="relative block aspect-[16/10] overflow-hidden bg-current/5"
              >
                <img src={shot(slug, e, 'desktop', resolved === 'dark')} alt="" className="size-full object-cover object-top" />
                <img
                  src={shot(slug, e, 'phone', resolved === 'dark')}
                  alt=""
                  className="absolute right-2 bottom-2 w-1/5 rounded-md shadow-lg ring-1 ring-current/20"
                />
              </button>
              <div className="flex flex-1 flex-col gap-2 p-2.5">
                <p className="min-w-0 wrap-anywhere">
                  <span className="font-medium">
                    {e.id} · {e.name}
                  </span>
                  <span className="block text-sm opacity-60">from {e.fromName}</span>
                </p>
                <div className="mt-auto flex flex-wrap gap-2">
                  <button type="button" onClick={() => onView(e.id)} className={OUTLINE}>
                    View
                  </button>
                  <button type="button" disabled={going} onClick={() => go(e)} className={PILL}>
                    Use this one
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dropped.map((e) => (
        <p key={e.id} className="text-sm opacity-60 wrap-anywhere">
          {e.id} (from {e.fromName}) did not pass its check{e.reasons?.[0] ? `: ${e.reasons[0]}` : ''}.
        </p>
      ))}
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm opacity-60">Or say below what to change.</p>
        {!passed.length && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => onSend('Try the design examples again.')} className={OUTLINE}>
              Try again
            </button>
            <button type="button" disabled={going} onClick={() => go(null)} className={PILL}>
              Build without an example
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * The examples full size, in Artefacts: the live page — its real fonts, and it scrolls —
 * on a phone's width or a desktop's, scaled down to fit the pane. Sandboxed twice: the route's
 * CSP, and the frame's own `sandbox` (no scripts, no same origin). It follows the viewer's
 * device for light or dark; the frame cannot be told otherwise from outside (probed), so a
 * 'both' example's other palette is its pictures, in the picker.
 */
export function DesignViewer({
  slug,
  view,
  viewing,
  onViewing,
  onSend,
  onPicked,
}: {
  slug: string
  view: DesignView
  viewing: ExampleId | null
  onViewing: (id: ExampleId) => void
  onSend: (text: string) => void
  onPicked: (v: DesignView) => void
}) {
  // A phone's own width on a phone: a 1280 page scaled into 330 px was unreadable (dev, 390).
  const [device, setDevice] = useState<'desktop' | 'phone'>(() =>
    typeof matchMedia === 'function' && !matchMedia('(min-width: 48rem)').matches ? 'phone' : 'desktop',
  )
  // As the picker's: a second tap while the pick is on its way answered 409 under the first.
  const { going, error, run } = useRun(onPicked)
  const passed = view.examples.filter((e) => e.status === 'passed')
  const shown = passed.find((e) => e.id === viewing) ?? passed.find((e) => e.id === view.picked) ?? passed[0]
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [shown?.id])
  // Brought into view when the chat's View asks for it. The pane's own scroller, never
  // scrollIntoView, which scrolls the phone's snap strip as well (see Chat's follow).
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = section.current
    const scroller = el?.closest<HTMLElement>('.overflow-y-auto')
    if (viewing && el && scroller) scroller.scrollTop = el.offsetTop - scroller.offsetTop
  }, [viewing])

  const scale = device === 'desktop' && width ? Math.min(1, width / 1280) : 1
  return (
    <section ref={section} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Design examples</h2>
        <div role="group" aria-label="device" className={`flex ${GROUP}`}>
          {(['desktop', 'phone'] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
              className={`min-h-9 rounded-md px-3 text-sm capitalize ${device === d ? ON : OFF}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div role="group" aria-label="examples" className="flex flex-wrap gap-1.5">
        {view.examples.map((e) => (
          <button
            key={e.id}
            type="button"
            aria-pressed={shown?.id === e.id}
            disabled={e.status !== 'passed'}
            onClick={() => onViewing(e.id)}
            className={`${chip(shown?.id === e.id)} disabled:opacity-35`}
          >
            {e.id}
            {e.name ? ` · ${e.name}` : ''}
            {view.picked === e.id ? ' ✓' : ''}
          </button>
        ))}
      </div>
      {shown ? (
        <>
          <p className="text-sm opacity-60 wrap-anywhere">
            {shown.id} · {shown.name}, from {shown.fromName}
            {view.picked === shown.id ? ' — picked' : ''}
          </p>
          <div ref={box} className="overflow-hidden rounded-lg border border-current/15 bg-current/5">
            {device === 'desktop' ? (
              <div style={{ height: 800 * scale }}>
                <iframe
                  key={`${shown.id}-${shown.at}`}
                  title={`design ${shown.id}, ${shown.name}`}
                  sandbox=""
                  src={page(slug, shown)}
                  style={{ width: 1280, height: 800, transform: `scale(${scale})`, transformOrigin: '0 0' }}
                  className="block border-0"
                />
              </div>
            ) : (
              <iframe
                key={`${shown.id}-${shown.at}-phone`}
                title={`design ${shown.id}, ${shown.name}, on a phone`}
                sandbox=""
                src={page(slug, shown)}
                className="mx-auto block h-[720px] w-[390px] max-w-full border-0"
              />
            )}
          </div>
          {view.phase === 'pick' && (
            <button type="button" disabled={going} onClick={() => run(() => choose(slug, shown, onSend))} className={PILL}>
              Use this one
            </button>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </>
      ) : (
        <p className="text-sm opacity-60">
          {view.examples.some((e) => e.status === 'waiting') ? 'The examples are being written.' : 'None of the examples passed the design check.'}
        </p>
      )}
      {view.examples
        .filter((e) => e.status === 'dropped')
        .map((e) => (
          <p key={e.id} className="text-sm opacity-60 wrap-anywhere">
            {e.id} (from {e.fromName}) did not pass its check{e.reasons?.length ? `: ${e.reasons.join(' · ')}` : ''}.
          </p>
        ))}
    </section>
  )
}

/**
 * A route's answer, and the other pane told: the chat's card and Artefacts each hold the view,
 * and Back pressed in one left the other's Approve answering 409 (review, #32).
 */
const post = async (slug: string, what: 'approve' | 'unpick') => {
  const view = await json<DesignView>(`/api/projects/${slug}/designs/${what}`, 'POST', {})
  touched(slug)
  return view
}

/** The approval, as the route takes it — code writes the design into the app — then the message that starts the plan. */
async function approveDoc(slug: string, send: (text: string) => void): Promise<DesignView> {
  const view = await post(slug, 'approve')
  send('Approve the design.')
  return view
}

/** Back to the examples: the pick and its DESIGN.md undone, and the picker back. No message: nothing runs. */
const unpickDoc = (slug: string): Promise<DesignView> => post(slug, 'unpick')

/** Approve and Back to the examples, or, before DESIGN.md is written, Write it: one set for both panes. */
export function DocActions({
  slug,
  doc,
  onRead,
  onSend,
  onChanged,
}: {
  slug: string
  doc: DocView
  onRead?: () => void
  onSend: (text: string) => void
  onChanged: (v: DesignView) => void
}) {
  const { going, error, run } = useRun(onChanged)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {doc.at ? (
          <>
            {onRead && (
              <button type="button" onClick={onRead} className={OUTLINE}>
                Read it
              </button>
            )}
            <button type="button" disabled={going} onClick={() => run(() => approveDoc(slug, onSend))} className={PILL}>
              Approve
            </button>
          </>
        ) : (
          <button type="button" disabled={going} onClick={() => onSend('Write DESIGN.md.')} className={PILL}>
            Write it
          </button>
        )}
        <button type="button" disabled={going} onClick={() => run(() => unpickDoc(slug))} className={OUTLINE}>
          Back to the examples
        </button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {doc.at && <p className="text-sm opacity-60">Or say below what to change in it.</p>}
    </div>
  )
}

/**
 * At the end of the chat once an example is picked and no turn runs (phase 'draft' or
 * 'approve'): DESIGN.md is ready — the picked page's picture, its colours and the builder's one
 * line about it, with Read it, Approve and Back to the examples. Before it is written (a turn
 * that ended without saving it), Write it instead of Approve.
 */
export function DocCard({
  slug,
  view,
  onRead,
  onSend,
  onChanged,
  grew,
}: {
  slug: string
  view: DesignView
  onRead: () => void
  onSend: (text: string) => void
  onChanged: (v: DesignView) => void
  grew: () => void
}) {
  const { resolved } = useTheme()
  const doc = view.doc!
  const ex = view.examples.find((e) => e.id === doc.example)
  useLayoutEffect(() => grew(), [grew, doc.at])
  return (
    <section aria-label="DESIGN.md" className={CARD}>
      <header>
        <h2 className="text-base font-medium">{doc.at ? 'DESIGN.md is ready' : 'DESIGN.md is not written yet'}</h2>
        <p className="text-sm opacity-60 wrap-anywhere">
          {doc.at
            ? `Design ${doc.example}${ex?.name ? ` · ${ex.name}` : ''}, written down for the build. Approve it and the app is built in it.`
            : `Design ${doc.example} is picked; the builder writes it down before anything is planned.`}
        </p>
      </header>
      {doc.at && ex && (
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={onRead}
            aria-label="read DESIGN.md"
            className="block aspect-[16/10] w-40 shrink-0 overflow-hidden rounded-md border border-current/15 bg-current/5"
          >
            <img src={shot(slug, ex, 'desktop', resolved === 'dark')} alt="" className="size-full object-cover object-top" />
          </button>
          <div className="min-w-0 flex-1 basis-48 space-y-2">
            <Swatches colors={Object.values(resolved === 'dark' && doc.front.colorsDark ? { ...doc.front.colors, ...doc.front.colorsDark } : doc.front.colors)} className="w-40" />
            {doc.sections?.description && <p className="text-sm leading-relaxed wrap-anywhere">{doc.sections.description}</p>}
          </div>
        </div>
      )}
      <DocActions slug={slug} doc={doc} onRead={onRead} onSend={onSend} onChanged={onChanged} />
    </section>
  )
}

/** A label and what it holds, in the Artefacts pane: the spec's, the brief's, DESIGN.md's. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className={LABEL}>{title}</h3>
      {children}
    </section>
  )
}
