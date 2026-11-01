import {
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ComponentType } from 'react'
import { flushSync } from 'react-dom'
import type { Parked } from './CodeView'
import FileTree from './FileTree'
import { type FileBody, type Tree, type Written, api, json } from './api'
import { useChat, useLatest } from './hooks'

type CodeViewProps = {
  path: string
  content: string
  was?: string
  parked: Map<string, Parked>
  onSave: (content: string) => void
  onDirty: (dirty: boolean) => void
}

/**
 * A rejected dynamic import throws out of Suspense and unmounts the whole tree — a white
 * pane, and nothing in the console but the rejection. Catching it here keeps the failure
 * inside the code tab, where it can be read. This app has been bitten twice by a render
 * crash that looks exactly like a blank rectangle; see the private design log.
 */
const CodeView = lazy(async (): Promise<{ default: ComponentType<CodeViewProps> }> => {
  try {
    return await import('./CodeView')
  } catch (e) {
    const message = (e as Error).message
    return {
      default: () => (
        <p className="p-4 text-sm text-red-500">could not load the editor: {message}</p>
      ),
    }
  }
})

const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

/** `s` with `p` in or out — the same set when nothing changes, so React skips the render. */
function toggled(s: ReadonlySet<string>, p: string, on: boolean): ReadonlySet<string> {
  if (s.has(p) === on) return s
  const next = new Set(s)
  if (on) next.add(p)
  else next.delete(p)
  return next
}

/** The open files in tab order, and the one on screen. One state, because closing a tab
 *  moves both at once. `path` is null below md once `‹ files` is tapped, tabs kept. */
type Tabs = { open: string[]; path: string | null }

/**
 * Close every tab `gone` matches — the × on one tab, or whatever a turn deleted. If the
 * active one goes, the tab that slides into its slot takes over, else the one before it.
 */
function drop({ open, path }: Tabs, gone: (p: string) => boolean): Tabs {
  const kept = open.filter((p) => !gone(p))
  if (!path || !gone(path)) return { open: kept, path }
  const slot = open.slice(0, open.indexOf(path)).filter((p) => !gone(p)).length
  return { open: kept, path: kept[Math.min(slot, kept.length - 1)] ?? null }
}

export default function Files({ slug }: { slug: string }) {
  const [files, setFiles] = useState<string[]>([])
  const [{ open, path }, setTabs] = useState<Tabs>({ open: [], path: null })
  const [body, setBody] = useState<FileBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** By path: a save outlives the tab it came from, and another tab's ⌘S must still go
   *  through while it is in flight, not be swallowed by a flag they share. */
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())
  /** Tabs whose buffer differs from the disk: a ● where the × goes, and a confirm on close. */
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set())
  /** Each open tab's editor while another file is on screen — see CodeView's Parked. */
  const parked = useRef(new Map<string, Parked>())

  // The agent rewrites these files from under us, so the pane follows the chat store:
  // `busy` covers the two ends of a turn and `writes` bumps once per settled write or
  // delete, which is the batch boundary — every tool in one assistant message executes
  // together after that message finishes streaming, so files arrive in groups, not one
  // by one. No new plumbing: the store is already here and already notifies.
  const { busy, writes, wrote } = useChat(slug)
  // A turn's colours go as the next one starts, and the server empties its record of them
  // before that turn writes anything. The read the start of a turn fires can land before that,
  // so from the start of a turn to its first write, none are shown. The count is taken in the
  // render where `busy` turns, so no frame shows the old colours under a new turn.
  const [turn, setTurn] = useState({ busy, writes })
  if (turn.busy !== busy) setTurn({ busy, writes })
  const colours = !busy || writes > turn.writes

  useLatest(
    () => api<Tree>(`/api/projects/${slug}/files`),
    [slug, busy, writes],
    (d) => {
      setError(null)
      setFiles(d.files)
      // The turn may have deleted whatever was open.
      setTabs((t) => drop(t, (p) => !d.files.includes(p)))
    },
    (e) => setError(e.message),
  )

  // No file open answers null, which clears the error too, or a failed open leaves its banner
  // welded over the tree: on a stopped project nothing else re-runs to clear it.
  useLatest(
    () => (path ? api<FileBody>(`/api/projects/${slug}/file?path=${encodeURIComponent(path)}`) : Promise.resolve(null)),
    [slug, path, busy, writes],
    (d) => {
      setError(null)
      setBody(d)
    },
    (e) => setError(e.message),
  )

  /**
   * Write the buffer back. Everything that can go wrong here is a refusal the server
   * already knows how to phrase — a turn is running, or the token has moved — so it goes
   * straight into the banner below rather than growing a conflict UI of its own. The new
   * token comes back in the response, so a second ⌘S works without reopening the file.
   * The response lands wherever the pane is by then, so it only updates `body` if that
   * is still this file: a tab picked meanwhile has its own body, and overwriting it with
   * this one unmounted the editor and left the pane on "…".
   */
  async function save(content: string): Promise<void> {
    const at = path
    if (!at || saving.has(at)) return
    setSaving((s) => toggled(s, at, true))
    try {
      const saved = await json<Written>(`/api/projects/${slug}/file`, 'PUT', { path: at, content, token: body?.token })
      setError(null)
      setBody((b) => (b?.path === at ? { ...saved, content } : b))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving((s) => toggled(s, at, false))
    }
  }

  const strip = useRef<HTMLDivElement>(null)
  const tree = useRef<HTMLDivElement>(null)
  const openFile = (p: string) =>
    setTabs((t) => ({ open: t.open.includes(p) ? t.open : [...t.open, p], path: p }))
  // Committed at once, so focus can follow: the × just pressed is gone from the DOM, and
  // left alone the browser drops focus on <body> — from the keyboard, back to the top.
  // Onto the tab that slid into its slot (the new active one, if it was active), which is
  // under the finger already; the tree once none is left. preventScroll, because focus()
  // scrolls every scroller above too, and focusing a far-off active tab yanked the strip.
  const closeFile = (p: string) => {
    if (dirty.has(p) && !confirm(`Discard unsaved changes to ${p}?`)) return
    const slot = open.indexOf(p)
    flushSync(() => setTabs((t) => drop(t, (q) => q === p)))
    const left = strip.current?.children
    const next = left?.length
      ? left[Math.min(slot, left.length - 1)]?.querySelector('button')
      : tree.current?.querySelector('button')
    next?.focus({ preventScroll: true })
  }

  // Follow the agent: the file its newest write or edit landed in comes up in the editor, in a
  // tab of its own — behind yours while that has unsaved changes, which is you editing it. Once
  // the listing has it, so a refused write to a file that is not there opens nothing; and only
  // writes made since this pane was opened.
  const followed = useRef(wrote)
  useEffect(() => {
    const p = wrote?.path.replace(/^\.?\//, '')
    if (!p || wrote === followed.current || !files.includes(p)) return
    followed.current = wrote
    setTabs((t) => ({
      open: t.open.includes(p) ? t.open : [...t.open, p],
      path: t.path !== null && dirty.has(t.path) ? t.path : p,
    }))
  }, [files, wrote])

  // A tab's parked editor and its mark go with the tab, whether × closed it or a turn
  // deleted its file. Here rather than in closeFile: closing the active tab unmounts its
  // editor, whose cleanup parks it again after closeFile has run.
  useEffect(() => {
    for (const p of parked.current.keys()) if (!open.includes(p)) parked.current.delete(p)
    setDirty((s) => ([...s].every((p) => open.includes(p)) ? s : new Set([...s].filter((p) => open.includes(p)))))
  }, [open])

  // The fetch for a newly picked file lands a moment later, and until it does `body`
  // still describes the previous one. Keying on the path stops the header and the editor
  // disagreeing, without blanking the pane when a finished turn refetches the same file.
  const shown = body && body.path === path ? body : null

  // A tab opened past the right edge is brought into view. Not scrollIntoView: that also
  // scrolls every scroller above the strip, the pane deck included (see the design log, The
  // pane strip scrolls sideways only). The strip is `relative`, so offsetLeft is into it.
  // Again once the file lands: the ⌘S and size beside the strip come back then and narrow
  // it, which pushed a just-opened last tab 75 px back out of view. Not on `open`: closing
  // a tab you are not on, or a refetch during a turn, would yank the strip back to the
  // active tab while you scroll it. A layout effect, so the new tab is never painted out
  // of view first.
  useLayoutEffect(() => {
    const s = strip.current
    const tab = path ? s?.children[open.indexOf(path)] : null
    if (!s || !(tab instanceof HTMLElement)) return
    if (tab.offsetLeft < s.scrollLeft) s.scrollLeft = tab.offsetLeft
    else if (tab.offsetLeft + tab.offsetWidth > s.scrollLeft + s.clientWidth)
      s.scrollLeft = tab.offsetLeft + tab.offsetWidth - s.clientWidth
  }, [path, shown?.path])

  return (
    <div className="relative flex-1 min-h-0 flex">
      {/*
        Two columns at md and up. Below that there is no room for both, so the tree is the
        pane until a file is picked and the reader is the pane afterwards — the same
        one-thing-at-a-time idiom as the swipe deck outside it. The tree is 40% of the pane,
        160 to 256 px: at a fixed 256 the editor was 94 px at 768 wide and 62 with the chat
        dragged to its widest.
      */}
      <div
        ref={tree}
        className={`${
          path ? 'hidden md:flex' : 'flex'
        } w-full md:w-[clamp(10rem,40%,16rem)] shrink-0 flex-col min-h-0 overflow-y-auto md:border-r border-current/10`}
      >
        <FileTree files={files} selected={path} onSelect={openFile} />
      </div>

      <div className={`${path ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col min-h-0`}>
        {open.length > 0 && (
          <div className="pr-2 md:pr-3 border-b border-current/10 flex items-center gap-2">
            <button
              onClick={() => setTabs((t) => ({ ...t, path: null }))}
              className="md:hidden shrink-0 ml-2 rounded-md px-2 py-1.5 text-sm opacity-70 hover:opacity-100"
            >
              ‹ files
            </button>
            {/*
              Its own sideways scroller, contained: below md the pane sits in the swipe deck,
              and a flick along the tabs should stop at their end, not carry on into the chat.
              The × sits over the tab's right padding rather than beside it, so where it is
              hidden a tap lands on the tab, not in a dead gap.
            */}
            <div ref={strip} className="relative flex-1 min-w-0 flex overflow-x-auto overscroll-x-contain">
              {open.map((p) => {
                const active = p === path
                const unsaved = dirty.has(p)
                return (
                  <div key={p} className="group relative shrink-0 border-r border-current/10">
                    <button
                      onClick={() => openFile(p)}
                      title={p}
                      aria-current={active ? 'true' : undefined}
                      className={`block max-w-48 truncate pl-3 pr-9 py-2.5 font-mono text-[13px] ${
                        active ? 'bg-current/10' : 'opacity-60 hover:opacity-100'
                      }`}
                    >
                      {p.slice(p.lastIndexOf('/') + 1)}
                    </button>
                    <button
                      onClick={() => closeFile(p)}
                      aria-label={`close ${p}${unsaved ? ', unsaved' : ''}`}
                      className={`absolute right-1 top-1/2 -translate-y-1/2 size-7 grid place-items-center rounded-md opacity-60 hover:opacity-100 hover:bg-current/10 ${
                        active || unsaved ? '' : 'invisible group-hover:visible group-focus-within:visible'
                      }`}
                    >
                      {/* Unsaved: a ● until the tab is hovered, then the × it stands in for. */}
                      {unsaved ? (
                        <>
                          <span className="group-hover:hidden">●</span>
                          <span className="hidden group-hover:inline">×</span>
                        </>
                      ) : (
                        '×'
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
            {shown && !shown.binary && (
              <span className="shrink-0 text-sm opacity-45 font-mono">{saving.has(shown.path) ? 'saving…' : '⌘S'}</span>
            )}
            {shown && <span className="shrink-0 text-sm opacity-45">{bytes(shown.size)}</span>}
          </div>
        )}
        {!path ? (
          <p className="flex-1 grid place-items-center text-sm opacity-50">select a file</p>
        ) : shown?.binary ? (
          <p className="flex-1 grid place-items-center text-sm opacity-50">not a text file</p>
        ) : shown?.content !== undefined ? (
          <Suspense
            fallback={<p className="flex-1 grid place-items-center text-sm opacity-50">…</p>}
          >
            <CodeView
              key={shown.path}
              path={shown.path}
              content={shown.content}
              was={colours ? shown.was : undefined}
              parked={parked.current}
              onSave={save}
              onDirty={(d) => setDirty((s) => toggled(s, shown.path, d))}
            />
          </Suspense>
        ) : (
          <p className="flex-1 grid place-items-center text-sm opacity-50">…</p>
        )}
      </div>

      {error && (
        <p className="absolute bottom-0 inset-x-0 px-3 py-2 text-sm text-red-500 bg-paper border-t border-current/10">
          {error}
        </p>
      )}
    </div>
  )
}
