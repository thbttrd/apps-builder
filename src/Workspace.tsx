import { type CSSProperties, useEffect, useRef, useState } from 'react'
import Artefacts from './Artefacts'
import Chat from './Chat'
import ChatEdge, { CHAT_DEFAULT, chatWidth, storedWidth } from './ChatEdge'
import Chips, { PANE, PANES, type Pane } from './Chips'
import Files from './Files'
import History from './History'
import { ProjectMore, type Section } from './More'
import ThemeToggle from './ThemeToggle'
import { type ExampleId, type Project, json } from './api'
import { CloseIcon, DesktopIcon, ExternalIcon, MobileIcon, ReloadIcon, TabletIcon } from './icons'
import { ACTION, GROUP, OFF, ON } from './ui'
import { send } from './chatStore'
import { useChat } from './hooks'

/**
 * The frame is sized in CSS pixels, so the app inside lays out at that viewport and its
 * own media queries fire — no postMessage needed across the preview's separate origin.
 * `null` is the real pane: a scaled-down "desktop" would lie about the breakpoint.
 */
const FORM_FACTORS = {
  desktop: null,
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const

type FormFactor = keyof typeof FORM_FACTORS

/** Keyed by form factor, so adding one to FORM_FACTORS cannot compile without a glyph. */
const DEVICE_ICON: Record<FormFactor, typeof DesktopIcon> = {
  desktop: DesktopIcon,
  tablet: TabletIcon,
  mobile: MobileIcon,
}

/** The preview's form factors: a glyph each, its viewport in the title. */
function FormFactors({ device, onDevice }: { device: FormFactor; onDevice: (f: FormFactor) => void }) {
  return (
    <div role="group" aria-label="form factor" className={`flex ${GROUP}`}>
      {(Object.keys(FORM_FACTORS) as FormFactor[]).map((f) => {
        const dim = FORM_FACTORS[f]
        const Glyph = DEVICE_ICON[f]
        return (
          <button
            key={f}
            onClick={() => onDevice(f)}
            aria-pressed={f === device}
            // aria-label carries the word the button no longer prints; title carries
            // the viewport it switches to, which is the one thing the glyph cannot
            // say and the actual reason to choose one over another.
            aria-label={f}
            title={dim ? `${f} — ${dim.width}×${dim.height}` : `${f} — the full pane`}
            className={`rounded-md p-1.5 ${f === device ? ON : OFF}`}
          >
            <Glyph className="size-4" />
          </button>
        )
      })}
    </div>
  )
}

/**
 * The panes before the first build. Preview, Code and History would show only the template;
 * Artefacts stays, because the plan-first gate asks the person to read the plan there before
 * anything is built, and More, because the model and the gate are chosen there.
 */
const EARLY: Pane[] = ['artefacts', 'more']

/** The side pane's slide and the chat's width alike, so the two edges meet all the way. */
const SLIDE_SIDE = 'duration-400 ease-out motion-reduce:transition-none'
/** How long the reveal waits for the first build to load before it slides in anyway. */
const LOAD_WAIT_MS = 2000

const money = (usd: number) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`)

export default function Workspace({
  project,
  busy,
  error,
  onBack,
  onChange,
  onStart,
  onStop,
}: {
  project: Project
  busy: boolean
  error: string | null
  onBack: () => void
  /** Called with a new slug when the project was renamed, without one after any other change. */
  onChange: (nextSlug?: string) => void
  onStart: () => void
  /** Stops the running preview: the cluster runs 8 at most, and a start past them asks for this. */
  onStop: () => void
}) {
  const [device, setDevice] = useState<FormFactor>('desktop')
  const [tab, setTab] = useState<Pane>(project.built ? 'preview' : 'artefacts')
  const [section, setSection] = useState<Section>('settings')
  /** The design example the chat's View opened in Artefacts. */
  const [viewing, setViewing] = useState<ExampleId | null>(null)
  /** Bumped by the chat's Read it, which brings DESIGN.md into view in Artefacts. */
  const [readTimes, setReadTimes] = useState(0)
  /**
   * Whether the workspace is laid out as a built project's: the preview beside the chat and
   * every chip. From the start for a project already built; for one built while it is open,
   * only once its first build has loaded out of sight — then it slides in (see below).
   */
  const [asBuilt, setAsBuilt] = useState(project.built)
  /** Before then, whether Artefacts or More is slid in beside the chat. */
  const [slidIn, setSlidIn] = useState(false)
  /** The first build landed while a pane was beside the chat: the Preview chip blinks until opened. */
  const [ready, setReady] = useState(false)
  /** Whether a pane is beside the chat; when not, the chat has the width to itself. */
  const side = asBuilt || slidIn
  const panes = asBuilt ? PANES : EARLY
  /** Mount the code pane once it has been asked for, then only hide it — same reason
   *  the iframe is never unmounted: remounting throws away the editor and the fetch. */
  const [codeSeen, setCodeSeen] = useState(false)
  /** Bumped by the reload button, which is the one time remounting the frame is the point. */
  const [reloads, setReloads] = useState(0)
  /** px, or null for CHAT_DEFAULT. */
  const [chatW, setChatW] = useState<number | null>(storedWidth)
  const [dragging, setDragging] = useState(false)

  const slug = project.slug
  // The tally as the running turn books it, step by step; the listing's catches up when it
  // settles. The number, not the state: a snapshot of the state is new with every `thought`,
  // four times a second, and would redraw the whole workspace with it.
  const usd = useChat(slug, (s) => s.usd)
  const size = FORM_FACTORS[device]
  const previewControls = asBuilt && project.running && tab === 'preview'
  /**
   * The frame exists from the first build on — before it, it would load the template — and
   * stays once it is in, whatever a later listing says: mid-turn, `built` is whether the preview
   * serves the page right now, and a write can break that for a moment.
   */
  const framed = (project.built || asBuilt) && project.running && project.url

  /*
    The first build, landing while the project is open: the listing says `built` as it lands,
    mid-turn (see below), or when the turn settles. With the chat alone, the frame mounts out of
    sight — off the right edge at md, in the hidden pane below it — and the slide waits for it to
    load, so what slides in is the app and not a white box; a preview that is not running has
    nothing to wait for. With a pane beside the chat, the person is reading it: it stays, the
    frame loads behind it, and the Preview chip blinks until it is opened.
  */
  const reveal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loaded = () => {
    clearTimeout(reveal.current)
    setAsBuilt(true)
  }
  useEffect(() => {
    if (!project.built || asBuilt) return
    if (slidIn) {
      setReady(true)
      return setAsBuilt(true)
    }
    setTab('preview')
    if (!framed) return setAsBuilt(true)
    reveal.current = setTimeout(() => setAsBuilt(true), LOAD_WAIT_MS)
    return () => clearTimeout(reveal.current)
  }, [project.built, asBuilt, slidIn, framed])

  /*
    The first build, seen as it lands: the listing says `built` once the turn has rewritten
    Home.tsx and the preview serves it, before its commit — but the listing is refetched at the
    turn's end, so before the first build each write asks for it again. A turn only watched — the
    page reloaded mid-build, the laptop asleep — sends no writes: while one runs, the listing is
    asked for every 2 s instead, as the watcher asks for the chat.
  */
  const wrote = useChat(slug, (s) => s.wrote)
  useEffect(() => {
    if (wrote && !project.built) onChange()
  }, [wrote])
  const watching = useChat(slug, (s) => s.busy && !s.attached)
  useEffect(() => {
    if (!watching || project.built) return
    const poll = setInterval(() => onChange(), 2000)
    return () => clearInterval(poll)
  }, [watching, project.built])

  /** Actions, not modes: no well, or they would read as one more segmented group beside the
   *  form factors. In the bar from md, and beside `‹ chat` on a phone, where the bar has no
   *  room — main had them in the bar at every width, and a stuck preview needs its reload. */
  const previewActions = previewControls && (
    <>
      <button
        onClick={() => setReloads((n) => n + 1)}
        aria-label="reload preview"
        title="reload preview"
        className={ACTION}
      >
        <ReloadIcon className="size-4" />
      </button>
      <a
        href={project.url}
        target="_blank"
        rel="noreferrer"
        aria-label="open preview in a new tab"
        title={project.url}
        className={ACTION}
      >
        <ExternalIcon className="size-4" />
      </a>
    </>
  )

  const pick = (k: Pane) => {
    // Before the first build a chip slides its pane in, and pressing the one in force slides
    // it back out: there is no preview for the pane to go back to.
    if (!asBuilt && slidIn && k === tab) return setSlidIn(false)
    reach(k)
  }
  /** Brings pane `k` in beside the chat, and to the front on a phone. */
  const reach = (k: Pane) => {
    setTab(k)
    setSlidIn(true)
    if (k === 'code') setCodeSeen(true)
    if (k === 'preview') setReady(false)
    // On a phone the chips are also the way to the pane they name, from the chat: the `›`
    // that did it went with the model line. Below md only — at md the pane is already in
    // view, and this would scroll the strip, which is overflow-hidden there, not unscrollable.
    // A frame later, for a pane that is only now leaving `hidden`.
    if (!matchMedia('(min-width: 48rem)').matches) {
      requestAnimationFrame(() =>
        document.getElementById('ab-preview')?.scrollIntoView({ block: 'nearest', inline: 'start' }),
      )
    }
  }

  /*
    Three whole strings, never `hidden` prepended to a list that also carries `flex`:
    both are display utilities, so which one won would be settled by Tailwind's output
    order rather than by anything written here.
  */
  const stage =
    tab !== 'preview'
      ? 'hidden'
      : size
        ? 'flex-1 min-h-0 overflow-auto p-2 md:p-4 flex items-start justify-center-safe'
        : 'flex-1 min-h-0 p-2 md:p-4'

  return (
    <div
      // Here rather than on the chat, so the bar's left half is the chat's width too, and the
      // chips sit at the preview's left edge — while the preview is at least as wide as the
      // bar's controls (about 31rem on Preview). Narrower, the left half gives way (see the
      // header) and the chips move left by the difference: over the chat once it passes
      // their 16 px inset (96 px at a 768 window).
      style={{ '--chat-w': chatW === null ? CHAT_DEFAULT : chatWidth(chatW) } as CSSProperties}
      className="h-dvh flex flex-col bg-paper text-ink"
    >
      {/*
        Split as Lovable's is: over the chat, the project; over the preview, the chips at its
        left edge, what the pane in view offers in the middle, and the way out of it on the
        right. Below md the panes are a swipe strip of full screens, so the bar is one row —
        the project, then the chips — and the middle and right go, the ✕ with them: the
        Preview chip does what it does.
      */}
      <header className="shrink-0 border-b border-current/10 flex items-center">
        {/* The chat's width, but the half that gives way: at 768 the chat's 384 px minimum
            leaves the other half less than its controls need (96 px short, measured), and a
            truncated slug beats a bar pushed off the screen. With no pane beside the chat,
            all of the bar but what the chips need, and it narrows with the chat as a pane
            slides in, so the chips ride its edge to the pane's. Not while the edge is
            dragged, where a transition would trail the pointer. */}
        <div
          className={`min-w-0 flex-1 md:grow-0 ${side ? 'md:basis-(--chat-w)' : 'md:basis-full'} ${
            dragging ? '' : `md:transition-[flex-basis] ${SLIDE_SIDE}`
          } px-2 md:px-3 py-2 flex items-center gap-1.5 md:gap-2`}
        >
          <button
            onClick={onBack}
            className="shrink-0 rounded-lg px-2 py-1.5 text-sm opacity-70 hover:opacity-100 hover:bg-current/5"
          >
            ‹ <span className="hidden sm:inline">Projects</span>
          </button>
          <button
            className="min-w-0 truncate text-sm md:text-[15px] font-medium hover:underline"
            title="rename project"
            onClick={() => {
              const name = prompt('Rename project', slug)
              if (!name || name === slug) return
              void json<Project>(`/api/projects/${slug}`, 'PATCH', { name })
                .then((p) => onChange(p.slug))
                // The only mutation in the client outside App's act(), so nothing else
                // surfaces its refusals: a 409 name collision, or a name that slugifies to
                // nothing, used to close the prompt and change nothing, silently.
                .catch((e: Error) => alert(e.message))
            }}
          >
            {slug}
          </button>
          {project.running ? (
            // The running dot is the Stop: a dot at rest, a ring around it on hover.
            <button
              className="shrink-0 grid place-items-center size-5 -m-1.5 rounded-full hover:bg-current/10 disabled:opacity-40"
              disabled={busy}
              onClick={onStop}
              title={`running on :${project.port} — stop the preview`}
              aria-label="stop the preview"
            >
              <span className="size-1.5 rounded-full bg-emerald-500" />
            </button>
          ) : (
            <span className="shrink-0 size-1.5 rounded-full bg-current/25" title="stopped" />
          )}
          <span
            className="shrink-0 text-xs md:text-sm font-mono opacity-45"
            title={`${project.turns} turns`}
          >
            {money(Math.max(project.usd, usd))}
          </span>
        </div>

        {/* Three columns, the outer two equal, so the middle one is centred on the preview
            rather than on whatever the chips and the right-hand controls leave over. */}
        <div className="shrink-0 md:flex-1 pr-2 md:px-4 py-2 flex md:grid md:grid-cols-[1fr_auto_1fr] items-center gap-2">
          {/* Keyed by the set, so the first build's five are measured afresh (see Chips). */}
          <Chips key={panes.join()} panes={panes} tab={side ? tab : null} blink={ready ? 'preview' : null} onPick={pick} />
          {/* The blink, said: a screen reader does not see one. Outside Chips, which the first
              build remounts, and there before it speaks, as a live region has to be. */}
          <span role="status" className="sr-only">
            {ready ? 'The app is ready in Preview.' : ''}
          </span>

          <div className="hidden md:flex items-center gap-1.5">
            {!side ? null : tab !== 'preview' ? (
              // Only from lg: it says what the chip in force already does, and at md it is
              // squeezed between the chips and the theme.
              <span className="hidden lg:inline text-sm font-medium">{PANE[tab].label}</span>
            ) : (
              previewControls && (
                <>
                  {/* The form factors are a property of the preview, not a fifth pane, so
                      they exist only while it shows. Emulating a phone on a phone is
                      theatre, and below md the bar has no room for it anyway. */}
                  <FormFactors device={device} onDevice={setDevice} />
                  {previewActions}
                </>
              )
            )}
          </div>

          <div className="hidden md:flex items-center justify-end gap-2">
            {/* A preference, and the one control here that is not about this project, so it
                goes past the things you came here to press. The projects screen keeps its
                copy at every width, so a phone switches theme there and comes back. */}
            <ThemeToggle className="flex" />
            {side && tab !== 'preview' && (
              <button
                onClick={(e) => {
                  // Onto a chip first, as Picker hands focus back to its opener: this button
                  // goes with the pane, and would drop the focus on <body>. The Preview chip,
                  // or before the first build the one whose pane this closes.
                  const header = e.currentTarget.closest('header')
                  const to = asBuilt
                    ? header?.querySelector<HTMLElement>('[aria-label=pane] > button')
                    : header?.querySelector<HTMLElement>('[aria-label=pane] > button[aria-pressed=true]')
                  to?.focus()
                  if (asBuilt) pick('preview')
                  else setSlidIn(false)
                }}
                aria-label={asBuilt ? 'back to the preview' : `close ${PANE[tab].label}`}
                title={asBuilt ? 'back to the preview' : `close ${PANE[tab].label}`}
                className="shrink-0 rounded-full border border-current/15 p-1.5 opacity-70 hover:opacity-100 hover:bg-current/5"
              >
                <CloseIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      {error && (
        <p className="shrink-0 px-3 py-1.5 text-sm text-red-500 border-b border-current/10">
          {error}
        </p>
      )}

      {/*
        One horizontal scroll-snap strip. Below md each pane is the full viewport, so a
        swipe moves between them with no gesture handler; at md the two fit side by side,
        the container stops overflowing, and it is the old two-column layout again.
        Both ways are scrollIntoView — to the preview a chip (see pick), back to the chat
        `‹ chat` — which leaves no history entry, so the back button does not step between
        panes. `‹ chat` was a fragment link, whose one entry cost a back press that moved
        nothing.
      */}
      <div className="relative flex-1 min-h-0 flex overflow-x-auto overscroll-x-contain snap-x snap-mandatory scroll-smooth md:overflow-x-hidden md:snap-none">
        {/* A third of the window, within bounds: 384 px (what it always was) up to about
            1200, 608 from about 1900. A fixed 384 at 1920 left the chat a fifth of the
            screen and its text at 12–14 px to fit; Lovable gives it about 30%. Its right
            edge drags, as Lovable's does. With no pane beside it — before the first build —
            the whole width, its column centred inside (see Chat), narrowing as one slides
            in. No edge to drag then, and no transition while one is dragged. Clipped
            vertically, as the preview pane is (see there); only vertically, or the edge,
            12 px out to the right, would be cut off. */}
        <div
          id="ab-chat"
          className={`relative w-full shrink-0 snap-start ${side ? 'md:w-(--chat-w) border-r' : 'md:w-full'} ${
            dragging ? '' : `md:transition-[width] ${SLIDE_SIDE}`
          } min-h-0 overflow-y-clip flex flex-col border-current/10`}
        >
          <Chat
            key={slug}
            project={project}
            onView={(id) => {
              setViewing(id)
              setReadTimes(0)
              reach('artefacts')
            }}
            onRead={() => {
              setViewing(null)
              setReadTimes((n) => n + 1)
              reach('artefacts')
            }}
          />
          {side && <ChatEdge width={chatW} onWidth={setChatW} onDrag={setDragging} />}
        </div>
        {/* While dragging, over everything — the preview's iframe above all, which would
            otherwise take the pointer the moment it crossed into the frame. */}
        {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}

        {/* Positioned, as the chat column is, so an absolute box in a pane — every sr-only
            text is one — is placed in the strip and not against the page. Below md this pane
            sits a screen to the right; a step's hidden status in Artefacts, with no positioned
            ancestor, stayed there in page coordinates and made a 390 px page 70–275 px wide.
            Both panes clip vertically, for the same boxes one level in: in a pane's scroller,
            which is not positioned, an sr-only box escapes to the pane at its unscrolled place,
            the live "thinking" far under the fold. The strip is a vertical scroller too — its
            overflow-x turns overflow-y's `visible` into `auto` — so that overflow let a wheel
            slide the whole column up over empty space. `clip`, not `hidden`: script can still
            scroll a hidden box (see the design log, The pane strip scrolls sideways only).
            At md, laid over the strip's right-hand side at its final width rather than grown
            from nothing beside the chat, so it slides in whole: grown, the app in the frame
            would lay itself out again at every width on the way. Out of sight, it is off the
            right edge (the strip clips it) and inert; below md, where the strip scrolls, it is
            not there at all. */}
        <main
          id="ab-preview"
          inert={!side}
          className={`relative w-full shrink-0 snap-start md:absolute md:inset-y-0 md:right-0 md:w-[calc(100%-var(--chat-w))] min-w-0 ${
            side ? 'flex md:translate-x-0' : 'hidden md:flex md:translate-x-full'
          } md:transition-transform ${SLIDE_SIDE} overflow-y-clip flex-col bg-current/5`}
        >
          {/*
            On a phone this is the only way back to the chat: a swipe that starts on the
            iframe scrolls the iframe, not the deck.
          */}
          <div className="md:hidden shrink-0 pr-2 flex items-center gap-1 border-b border-current/10">
            <button
              onClick={() =>
                document.getElementById('ab-chat')?.scrollIntoView({ block: 'nearest', inline: 'start' })
              }
              className="flex-1 px-3 py-2 text-left text-sm opacity-70 hover:opacity-100"
            >
              ‹ chat
            </button>
            {previewActions}
          </div>

          {/*
            Mounted on first use and hidden thereafter, never unmounted — remounting would
            refetch the listing and rebuild the editor every time the tab is flipped. It
            renders for a stopped project too: the files outlive the process serving them.
          */}
          {codeSeen && (
            <div className={tab === 'code' ? 'flex-1 min-h-0 p-2 md:p-4' : 'hidden'}>
              <div className="h-full flex flex-col overflow-hidden rounded-xl border border-current/10 bg-paper">
                <Files key={slug} slug={slug} />
              </div>
            </div>
          )}

          {/* Unmounted when hidden, unlike the code pane: it holds one fetch and no editor,
              and coming back to a stale timeline would be worse than refetching it. */}
          {tab === 'history' && <History key={slug} slug={slug} onChange={onChange} />}

          {/* Unmounted when hidden, as History is, for the same reason: one fetch, and a
              stale spec would be worse than refetching it. */}
          {tab === 'artefacts' && (
            <Artefacts
              key={slug}
              slug={slug}
              viewing={viewing}
              onViewing={setViewing}
              readTimes={readTimes}
              onSend={(text) => void send(slug, text)}
            />
          )}

          {/* Unmounted when hidden too, and for a reason of its own: Settings asks for a
              model list that failed to load again each time it mounts. */}
          {tab === 'more' && (
            <div className="flex-1 min-h-0 p-2 md:p-4">
              <ProjectMore key={slug} project={project} onChange={onChange} section={section} onSection={setSection} />
            </div>
          )}

          {framed ? (
            /*
              One iframe across every form factor — swapping elements would reload the app
              and lose its state. The code tab hides this with display:none for the same
              reason: the nested document survives, so the app is where you left it.
              items-start + justify-center-safe, not place-items-center: a centred item
              taller or wider than the pane puts its own top-left outside the scroll range,
              i.e. permanently unreachable.
            */
            <div className={stage}>
              {/* key on the url so switching projects remounts rather than reusing the frame.
                  Its load is what the first build's slide waits for. */}
              <iframe
                key={`${project.url}#${reloads}`}
                src={project.url}
                title={slug}
                onLoad={loaded}
                style={size ?? undefined}
                className={
                  size
                    ? 'shrink-0 rounded-xl border border-current/10 bg-white shadow-sm'
                    : 'w-full h-full rounded-xl border border-current/10 bg-white shadow-sm'
                }
              />
            </div>
          ) : asBuilt && tab === 'preview' ? (
            <div className="flex-1 grid place-items-center text-sm opacity-50">
              <button
                className="rounded-xl border border-current/20 px-4 py-2.5 disabled:opacity-40 hover:bg-current/5"
                disabled={busy}
                onClick={onStart}
              >
                {busy ? 'starting…' : 'start preview'}
              </button>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  )
}
