import { useEffect, useRef, useState } from 'react'
import type { DesignView } from './api'
import { DocActions, Section } from './Designs'

/** A front-matter value as the page reads: `{colors.primary}` is "primary". */
const said = (v: string | number) => String(v).replace(/\{(?:colors|rounded|typography)\.([^}]+)\}/g, '$1')

/**
 * The builder's prose as the person reads it: a token it names the catalog's way,
 * `{colors.primary}`, is the colour's swatch and its name; `{typography.body}` and the like, the
 * name. The file keeps the braces — they are what an agent reading DESIGN.md resolves.
 */
function Tokens({ text, colors }: { text: string; colors: Record<string, string> }) {
  const parts = text.split(/(\{(?:colors|typography|rounded|spacing|components?)\.[^}\s]+\})/g)
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\{(\w+)\.([^}]+)\}$/.exec(p)
        if (!m) return p
        const hex = m[1] === 'colors' ? colors[m[2]!] : undefined
        return (
          <span key={i} className="whitespace-nowrap font-medium">
            {hex && (
              <span aria-hidden="true" className="mr-1 inline-block size-2.5 rounded-sm align-baseline ring-1 ring-current/25" style={{ background: hex }} />
            )}
            {m[2]}
          </span>
        )
      })}
    </>
  )
}

/**
 * DESIGN.md in Artefacts, on top while the person reads it. Code's front matter first, drawn:
 * the colours as named swatches (a dark row for a light-and-dark design), the type styles, the
 * radii and spacing, the components; then the builder's sections, each as it wrote it — no
 * markdown renderer, so plain paragraphs, and the do's and don'ts as lists. The file itself
 * opens below them. Approve and Back to the examples while it waits for approval.
 */
export function DesignDoc({
  slug,
  view,
  readTimes,
  onSend,
  onChanged,
}: {
  slug: string
  view: DesignView
  /** Bumped by the chat's Read it: brought into view. */
  readTimes: number
  onSend: (text: string) => void
  onChanged: (v: DesignView) => void
}) {
  const doc = view.doc!
  const ex = view.examples.find((e) => e.id === doc.example)
  const { front, sections: s } = doc
  const [file, setFile] = useState<string | null>(null)
  // The pane's own scroller, never scrollIntoView (see DesignViewer).
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = section.current
    const scroller = el?.closest<HTMLElement>('.overflow-y-auto')
    if (readTimes && el && scroller) scroller.scrollTop = el.offsetTop - scroller.offsetTop
  }, [readTimes])
  const colours = (set: Record<string, string>) => (
    <ul className="grid grid-cols-2 gap-2 @md:grid-cols-4">
      {Object.entries(set).map(([name, hex]) => (
        <li key={name} className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="size-7 shrink-0 rounded-md ring-1 ring-current/20" style={{ background: hex }} />
          <span className="min-w-0 text-sm leading-tight wrap-anywhere">
            {name}
            <span className="block font-mono text-xs opacity-60">{hex}</span>
          </span>
        </li>
      ))}
    </ul>
  )
  const prose = (title: string, text: string | undefined) =>
    text && (
      <Section key={title} title={title}>
        <p className="whitespace-pre-line leading-relaxed wrap-anywhere">
          <Tokens text={text} colors={front.colors} />
        </p>
      </Section>
    )
  return (
    <section ref={section} aria-label="DESIGN.md" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">DESIGN.md</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs ${
            doc.approved ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-blue-500/15 text-blue-700 dark:text-blue-300'
          }`}
        >
          {doc.approved ? 'approved' : doc.at ? 'waiting for your approval' : 'being written'}
        </span>
      </div>
      {s?.description && <p className="text-base leading-relaxed wrap-anywhere">{s.description}</p>}
      <p className="text-sm opacity-60 wrap-anywhere">
        From design {doc.example}
        {ex?.name ? ` · ${ex.name}` : ''}
        {ex ? `, based on ${ex.fromName}` : ''}. The colours, type, shapes and components are read off that page; the
        writing is the builder’s.
      </p>
      {!doc.approved && doc.at && <DocActions slug={slug} doc={doc} onSend={onSend} onChanged={onChanged} />}
      <Section title="Colours">
        {colours(front.colors)}
        {front.colorsDark && (
          <>
            <p className="pt-1 text-sm opacity-60">In dark mode</p>
            {colours(front.colorsDark)}
          </>
        )}
      </Section>
      <Section title="Type">
        <ul className="divide-y divide-current/10 rounded-lg border border-current/10">
          {Object.entries(front.typography).map(([name, t]) => (
            <li key={name} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
              <span className="font-medium">{name}</span>
              <span className="text-sm opacity-70 wrap-anywhere">
                {[t.fontFamily, t.fontSize, t.fontWeight, t.lineHeight !== undefined ? `line ${t.lineHeight}` : '', t.textTransform ?? '']
                  .filter((x) => x !== '' && x !== undefined)
                  .join(' · ')}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Shapes and spacing">
        <ul className="flex flex-wrap items-end gap-3">
          {Object.entries(front.rounded).map(([name, r]) => (
            <li key={name} className="flex flex-col items-center gap-1 text-xs">
              <span aria-hidden="true" className="size-10 border-2 border-current/40 border-b-0 border-r-0" style={{ borderTopLeftRadius: name === 'full' ? 999 : r }} />
              <span>
                {name} <span className="opacity-60">{name === 'full' ? 'pill' : r}</span>
              </span>
            </li>
          ))}
        </ul>
        {front.spacing && (
          <p className="text-sm opacity-70 wrap-anywhere">
            Spacing: {Object.entries(front.spacing).map(([k, v]) => `${k} ${v}`).join(' · ')}
          </p>
        )}
      </Section>
      {front.components && (
        <Section title="Components">
          <ul className="space-y-2">
            {Object.entries(front.components).map(([name, c]) => (
              <li key={name} className="rounded-lg border border-current/10 px-3 py-2 wrap-anywhere">
                <p className="font-medium">{name}</p>
                <p className="text-sm opacity-70">
                  {Object.entries(c)
                    .map(([k, v]) => `${k} ${said(v)}`)
                    .join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {s ? (
        <>
          {prose('Overview', s.overview)}
          {prose('Colors', s.colors)}
          {prose('Typography', s.typography)}
          {prose('Layout', s.layout)}
          {prose('Elevation & Depth', s.elevation)}
          {prose('Shapes', s.shapes)}
          {prose('Components', s.components)}
          <Section title="Do's and Don'ts">
            <div className="grid gap-3 @xl:grid-cols-2">
              {(
                [
                  ['Do', s.dos],
                  ["Don't", s.donts],
                ] as const
              ).map(([head, lines]) => (
                <div key={head} className="rounded-lg border border-current/10 px-3 py-2.5">
                  <p className="font-medium">{head}</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm wrap-anywhere">
                    {lines.map((l, i) => (
                      <li key={i}>
                        <Tokens text={l} colors={front.colors} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>
          {prose('Responsive Behavior', s.responsive)}
          <details
            onToggle={(e) => {
              if ((e.target as HTMLDetailsElement).open && file === null) {
                fetch(`/api/projects/${slug}/design.md`)
                  .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
                  .then(setFile, (x: Error) => setFile(`Could not open it (${x.message}).`))
              }
            }}
            className="rounded-lg border border-current/10"
          >
            <summary className="cursor-pointer px-3 py-2 text-sm">The file, .apps-builder/DESIGN.md</summary>
            <pre className="max-h-[32rem] overflow-auto border-t border-current/10 p-3 text-xs leading-relaxed">{file ?? 'Opening…'}</pre>
          </details>
        </>
      ) : (
        <p className="text-sm opacity-60">The builder is writing the rest: what each of these is for, the layout on each device, the do’s and don’ts.</p>
      )}
    </section>
  )
}
