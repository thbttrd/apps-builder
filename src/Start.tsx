import { useEffect, useId, useRef, useState } from 'react'
import { slugify } from '../shared/slug'
import { short } from '../shared/models'
import More, { type Section, useDraft } from './More'
import ThemeToggle from './ThemeToggle'
import type { Settings } from './api'
import { CloseIcon, LayersIcon, SendIcon } from './icons'

/**
 * Where a new project starts, as Lovable's does: one question and one box. What is typed here
 * is the project's first message, and — when the projects screen was left empty — where its
 * name comes from. The project is only made when this is sent, so backing out leaves nothing
 * behind, and the workspace it opens on is already busy with the first turn.
 *
 * More is here too, over a draft (see useDraft): the first turn starts the moment the project
 * exists, so a model or a harness option chosen in the workspace's More would come a turn late.
 * The project is made with the draft, and a line under the box says what it will start with.
 */
export default function Start({
  name,
  busy,
  error,
  onBack,
  onStart,
}: {
  /** Typed on the projects screen, or '' to have the server name it from the prompt. */
  name: string
  busy: boolean
  error: string | null
  onBack: () => void
  onStart: (prompt: string, settings: Settings) => void
}) {
  const [prompt, setPrompt] = useState('')
  const status = useId()
  const text = prompt.trim()
  // `busy` is App's, and a delete sets it too: a Create pressed while one ran opened this page
  // saying "Starting…". So this page's own send is remembered, and cleared when busy drops —
  // a create that worked leaves the page, and one that failed must not relabel the next delete.
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (!busy) setSent(false)
  }, [busy])
  const starting = busy && sent

  const draft = useDraft()
  const [more, setMore] = useState(false)
  const [section, setSection] = useState<Section>('settings')
  const sheet = useRef<HTMLDialogElement>(null)
  const title = useId()
  // Modal, so the page behind is inert and Escape closes it; the browser puts the focus back on
  // More. Its sections mount only while it is open: Settings fetches the model list on mount.
  useEffect(() => {
    if (more) sheet.current?.showModal()
  }, [more])
  const { model, gate, design } = draft.settings

  return (
    <div className="relative h-dvh overflow-y-auto bg-paper text-ink">
      <div aria-hidden className="wash pointer-events-none absolute inset-0" />

      <header className="relative mx-auto max-w-6xl px-4 md:px-8 py-3 flex items-center gap-2">
        {/* Not while the project is being made: the create cannot be called back, and when it
            lands App opens the workspace and sends the prompt, so leaving would only be
            undone a moment later. aria-disabled, as the send button is, to keep the focus. */}
        <button
          onClick={() => {
            if (!starting) onBack()
          }}
          aria-disabled={starting}
          title={starting ? 'setting up the project…' : undefined}
          className="rounded-lg px-2 py-1.5 text-sm opacity-70 hover:opacity-100 hover:bg-current/5 aria-disabled:opacity-30 aria-disabled:hover:bg-transparent"
        >
          ‹ Projects
        </button>
        <div className="flex-1" />
        {/* Not while the project is being made: the draft has gone with the create. */}
        <button
          onClick={() => {
            if (!starting) setMore(true)
          }}
          aria-haspopup="dialog"
          aria-disabled={starting}
          className="flex min-h-11 md:min-h-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm opacity-70 hover:opacity-100 hover:bg-current/5 aria-disabled:opacity-30 aria-disabled:hover:bg-transparent"
        >
          <LayersIcon className="size-4" />
          More
        </button>
        <ThemeToggle className="flex" />
      </header>

      <dialog
        ref={sheet}
        aria-labelledby={title}
        onClose={() => setMore(false)}
        // A press on the backdrop lands on the dialog itself; one inside lands on its content.
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close()
        }}
        className="m-0 ml-auto h-dvh max-h-none w-full max-w-none border-0 bg-transparent p-0 text-ink md:w-[40rem] backdrop:bg-black/40 transition-transform duration-300 ease-out starting:open:translate-x-full motion-reduce:transition-none"
      >
        {more && (
          <div className="flex h-full flex-col bg-paper md:border-l md:border-current/10 md:shadow-2xl">
            <header className="flex items-start gap-3 px-4 pt-3 md:px-6 md:pt-4">
              <div className="min-w-0 flex-1 py-1">
                <h2 id={title} className="text-base font-semibold">
                  More
                </h2>
                <p className="text-sm opacity-60">For the project you are about to start. This browser keeps them for the next one.</p>
              </div>
              <button
                type="button"
                aria-label="close"
                onClick={() => sheet.current?.close()}
                className="grid size-11 md:size-9 shrink-0 place-items-center rounded-lg opacity-70 hover:opacity-100 hover:bg-current/5"
              >
                <CloseIcon className="size-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 p-2 md:p-4">
              <More target={draft} section={section} onSection={setSection} />
            </div>
          </div>
        )}
      </dialog>

      {/* A little above the middle, where Lovable has it: dead centre reads as low once the
          header is counted. */}
      <main className="relative mx-auto flex min-h-[calc(100dvh-4rem)] max-w-2xl flex-col justify-center px-4 pb-[12vh]">
        <h1 className="text-center text-3xl md:text-4xl font-semibold tracking-tight">What should we build?</h1>
        {name && (
          <p className="mt-2 text-center text-sm opacity-60">
            New project <span className="font-mono">{slugify(name)}</span>
          </p>
        )}

        <form
          className="mt-6 md:mt-8"
          onSubmit={(e) => {
            e.preventDefault()
            if (!text || busy) return
            setSent(true)
            onStart(text, draft.settings)
          }}
        >
          <div className="flex items-end gap-2 rounded-3xl border border-current/15 bg-paper/90 p-2 shadow-xl shadow-black/10 backdrop-blur focus-within:border-current/35">
            <textarea
              // The page is this box; there is nothing else to be focused for.
              autoFocus
              aria-label="what to build"
              aria-describedby={status}
              rows={3}
              // Grows with the text where the browser can (field-sizing), within a cap.
              className="min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-base leading-6 outline-none field-sizing-content min-h-[4.5rem] max-h-[40dvh]"
              placeholder="Describe the app you want — who it is for and what it should do…"
              value={prompt}
              // Read-only, not disabled, while the project is made: disabled drops the focus,
              // and a create that fails leaves the text here to send again.
              readOnly={starting}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Not the Enter that picks an IME candidate (see the composer in Chat).
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
            />
            {/* 44 px on a phone, the tap-target floor; 36 at md, as in the chat. */}
            <button
              aria-label="start building"
              title="start building (Enter)"
              aria-disabled={busy || !text}
              className="grid size-11 md:size-9 shrink-0 place-items-center rounded-full bg-ink text-paper aria-disabled:opacity-30"
            >
              <SendIcon className="size-4" />
            </button>
          </div>
        </form>

        {/* What the project will start with, as More has it: the draft outlives the page, so a
            model picked for one project would otherwise start the next unseen. */}
        <p className="mt-3 text-center text-sm">
          <button
            type="button"
            onClick={() => {
              if (!starting) setMore(true)
            }}
            aria-haspopup="dialog"
            aria-disabled={starting}
            className="rounded-md px-1.5 py-1 opacity-60 hover:opacity-100 hover:bg-current/5 aria-disabled:opacity-30 aria-disabled:hover:bg-transparent"
          >
            <span className="sr-only">Starts with: </span>
            {model ? short(model) : draft.house ? `${short(draft.house)} (house)` : 'the house model'}
            {' · '}
            {gate === 'plan' ? 'stops once, for the plan' : 'stops after each step'}
            {' · '}
            {design ? 'proposes a design first' : 'no design proposal'}
          </button>
        </p>

        {/* Always rendered, as a status, so a screen reader hears it change (see Projects). */}
        <p id={status} role="status" className="mt-3 min-h-5 text-center text-sm opacity-70">
          {starting ? 'Starting… setting up the project.' : ''}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-center text-sm text-red-500">
            {error}
          </p>
        )}
      </main>
    </div>
  )
}
