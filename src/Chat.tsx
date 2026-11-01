import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import Activity from './Activity'
import Ask from './Ask'
import type { ExampleId, Project } from './api'
import { Steps } from './Artefacts'
import { DesignPicker, DocCard, useArtefacts } from './Designs'
import { load, send, setDraft, stop } from './chatStore'
import { useChat } from './hooks'
import { SendIcon, StopIcon } from './icons'
import Note from './Note'
import { type Pin, hold, repin, settle } from './pin'
import Thinking from './Thinking'
import { ToolRow, WriteRow } from './ToolRow'

export default function Chat({
  project,
  onView,
  onRead,
}: {
  project: Project
  /** Opens a design example full size, in Artefacts. */
  onView: (id: ExampleId) => void
  /** Opens DESIGN.md, in Artefacts. */
  onRead: () => void
}) {
  const slug = project.slug
  // The turn lives in chatStore, so unmounting this component no longer abandons it.
  const { turns, draft, busy, usage, ready, attached, activity, heard } = useChat(slug)
  const scroller = useRef<HTMLDivElement>(null)
  // Whether the reader is at the bottom and wants to stay there. Starts pinned, so history
  // opens at its newest turn. See pin.ts for why it goes by direction.
  const pin = useRef<Pin>({ stuck: true, top: 0 })

  useEffect(() => {
    void load(slug)
  }, [slug])

  // Only while the reader is at the bottom. This used to scroll a sentinel into view on
  // every change, four times a second while the model reasons, so a reader who scrolled up
  // to read was pulled straight back down — and scrollIntoView scrolls every ancestor, the
  // phone's horizontal snap strip included, so it could also drag a reader who had swiped
  // to the preview back to the chat mid-turn. Setting scrollTop moves this scroller only.
  const follow = useCallback(() => {
    const el = scroller.current
    if (el) hold(pin.current, el)
  }, [])
  // Before paint, so a new line never shows for a frame above the fold. `turns` carries the
  // reasoning too now, so the thinking box growing is a `turns` change; the activity line
  // still changes on its own, and appears and goes without one. So does the usage line,
  // which arrives with `done` below this scroller and makes it 33 px shorter: unfollowed,
  // that left the chat as far from its bottom, and when the activity line went a moment
  // later with a reasoning panel open in view, scroll anchoring moved scrollTop up by the
  // line's height, which reads as the reader scrolling up, and the chat let go (1280x560
  // with the workspace's error line showing, and on short screens once a panel's cap
  // bottoms out).
  useLayoutEffect(() => {
    follow()
  }, [follow, turns, activity?.doing, activity?.what, usage])
  // The column changes width under the reader — the window, or the chat's edge dragged —
  // and the history rewraps without a scroll: narrower, it grows past the bottom of a
  // reader who was following it. Only while following, like every hold(). The scroller's
  // own box, so a panel growing inside it is not this; a banner going above it is.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => follow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [follow])
  // Thinking calls this after opening a panel, and Note after opening a ✎ note: both grow
  // the chat without a scroll.
  const settleChat = useCallback(() => {
    if (scroller.current) settle(pin.current, scroller.current)
  }, [])
  // What a live step's thinking calls instead, once opened: the reader is reading the newest
  // thing in the turn, so the chat goes to its bottom and follows it. Under that step there can
  // be the activity line, and the plan once its question arrives, so its own reveal, which
  // counted on nothing below it, stopped short of the bottom (844x390, review of #46).
  const following = useCallback(() => {
    pin.current = { stuck: true, top: 0 }
    follow()
  }, [follow])
  // Whoever sends wants to see the answer arrive, wherever they had scrolled to. Top 0 as
  // well, so the look hold() takes first cannot read a scroll up it has not been told about
  // yet as the reader letting go. The composer and a question card both send through here.
  const submit = useCallback(
    (text: string, ask?: string) => {
      pin.current = { stuck: true, top: 0 }
      void send(slug, text, ask)
    },
    [slug],
  )
  const asking = turns.some((t) => t.role === 'assistant' && t.ask)
  // The design examples, while the person picks one (server/design.ts). Not while a turn runs:
  // a revision may replace any of them.
  const { saved, setExamples } = useArtefacts(slug)
  const examples = saved?.examples ?? null
  const picking = !busy && examples?.phase === 'pick'
  // DESIGN.md, once an example is picked, until it is approved: its card, in place of the picker.
  const docCard = !busy && (examples?.phase === 'draft' || examples?.phase === 'approve') && !!examples.doc

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Above the scroller, not in it. The running banner goes in the same commit that adds
          the finished turn under it, and inside the scroller Chrome's scroll anchoring moved
          scrollTop up by the banner's height to keep the history still. hold() cannot tell
          that from the reader scrolling up, so the chat let go, and the turn the banner
          promised landed below the fold. Out here its going only makes the scroller taller,
          which for a reader scrolled up moves the history up by that height, once. */}
      {!ready && (
        <p className="mx-4 mt-3 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2.5 text-sm">
          OPENROUTER_API_KEY is not set — add it to the staging .env and restart the unit.
        </p>
      )}
      {busy && !attached && (
        <p className="mx-4 mt-3 rounded-xl bg-current/5 px-3 py-2.5 text-sm opacity-70">
          A turn is running that this tab isn't following — started before a reload, in another
          tab, or its connection dropped. It will appear here when it finishes. You can still stop it.
        </p>
      )}

      {/* A size container, so a reasoning panel can be capped at this box's height (see
          Thinking). Its size already came from the column, never from its content, so
          the size containment that comes with it changes none of the layout (measured, in
          the private design log). */}
      <div
        ref={scroller}
        onScroll={(e) => repin(pin.current, e.currentTarget)}
        className="@container-size flex-1 overflow-y-auto px-4 py-3 text-sm"
      >
        {/* A column of Lovable's width, centred: before the first build the chat has the
            whole window, and lines across all of it are unreadable. Beside a pane it is
            narrower than this already, so nothing changes there. The scroller stays the
            full width, so its scrollbar is at the window's edge. */}
        <div className="mx-auto max-w-3xl space-y-5">
          {turns.length === 0 && ready && !busy && (
            <p className="text-base opacity-50">
              {project.built ? 'Describe a change. It lands in the preview as you watch.' : 'Describe what to build.'}
            </p>
          )}
          {turns.map((t, i) => {
            // Attached implies the last turn is the live one; a watched turn is not in
            // `turns` until it finishes, so there is nothing to put a line under.
            const live = attached && i === turns.length - 1 ? activity : null
            // By the turn, not its place: a reload can drop turns above it (see Turn).
            return t.role === 'user' && t.note ? (
              <Note key={t.id} text={t.text} settle={settleChat} />
            ) : t.role === 'user' ? (
              /* Yours in a bubble on the right; the model's as plain text, the way Lovable
                 sets a reply — at 16 px across the column, prose reads as prose, and the grey
                 box it used to sit in only narrowed it. What it did goes in cards around it. */
              <div key={t.id} className="flex justify-end">
                <p className="max-w-[85%] rounded-2xl border border-current/15 bg-current/5 px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap wrap-anywhere">
                  {t.text}
                </p>
              </div>
            ) : (
              <div key={t.id} className="space-y-3">
                {/* In the order it happened: each step's thinking, then what it said and the
                    rows of what it did (see Turn). Keyed by place, which a segment keeps: the
                    flow only grows at its end, so an open thinking panel stays open as the
                    turn goes on and ends. Only the newest thing in a live turn is live. */}
                {t.flow.map((s, k) => {
                  const newest = !!live && k === t.flow.length - 1
                  return s.kind === 'tools' ? (
                    <ul key={k} className="rounded-xl border border-current/10 px-3 py-2 space-y-1">
                      {s.tools.map((tool) => (
                        <li key={tool.id}>
                          {/* Once written, a write or an edit opens on what it changed. */}
                          {tool.done && tool.detail && (tool.name === 'write_file' || tool.name === 'edit_file') ? (
                            <WriteRow slug={slug} tool={tool} settle={newest ? following : settleChat} />
                          ) : (
                            <ToolRow tool={tool} />
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : !s.text.trim() ? null : s.kind === 'text' ? (
                    <p key={k} className="text-base leading-relaxed whitespace-pre-wrap wrap-anywhere">
                      {s.text}
                    </p>
                  ) : (
                    <Thinking
                      key={k}
                      text={s.text}
                      live={newest}
                      thinking={newest && live.doing === 'thinking'}
                      settle={newest ? following : settleChat}
                    />
                  )
                })}
                {/* The plan a gate's question asks about, drawn by code from what update_plan
                    saved, with its question and left in place once it is answered (see Turn). */}
                {t.plan && !(t.ask && busy) && <Steps plan={t.plan} current={t.plan.next ?? -1} />}
                {t.ask && !busy && <Ask questions={t.ask} onAnswer={(text) => submit(text, t.askId)} grew={follow} />}
                {/* One place for the whole turn, so its status region is never remounted and
                    every change in it is announced (review of #46). */}
                {live && <Activity live={live} heard={heard} grew={follow} />}
              </div>
            )
          })}
          {picking && (
            <DesignPicker slug={slug} view={examples} onView={onView} onSend={submit} onPicked={setExamples} grew={follow} />
          )}
          {docCard && <DocCard slug={slug} view={examples} onRead={onRead} onSend={submit} onChanged={setExamples} grew={follow} />}
        </div>
      </div>

      {usage && (
        <p className="px-4 py-1.5 text-sm font-mono opacity-45 border-t border-current/10">
          <span className="mx-auto block max-w-3xl">
            in {usage.input} · cache r{usage.cacheRead}/w{usage.cacheWrite} · out {usage.output}
          </span>
        </p>
      )}

      {/* One box, the button inside it at the bottom right, as in Lovable: the text is the
          thing, and the control that sends it sits where the typing ends. Beside the text
          rather than on a row of its own under it, which Lovable fills with other controls
          and here would be 44 px of nothing: at 844x390 it would take the chat from 193 px
          to 149. The rule above it only once there is a preview beside the chat: across
          the whole window, under a centred column, it was a line through nothing. */}
      <form
        className={`px-3 md:px-4 py-2.5 ${project.built ? 'border-t border-current/10' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          const text = draft.trim()
          if (!text || busy) return
          submit(text)
          setDraft(slug, '')
        }}
      >
        <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-current/15 p-1.5 focus-within:border-current/40">
          <textarea
            className="min-w-0 flex-1 resize-none bg-transparent px-2.5 py-1.5 text-base leading-6 outline-none"
            rows={2}
            aria-label="message"
            placeholder={asking ? '…or type your own answer' : picking ? '…or say what to change' : project.built ? 'make the heading say…' : 'send a follow-up…'}
            value={draft}
            disabled={busy || !ready}
            onChange={(e) => setDraft(slug, e.target.value)}
            onKeyDown={(e) => {
              // Not the Enter that picks an IME candidate, which would send half a sentence
              // as a paid turn. Most browsers mark it isComposing; Safari sends it after
              // compositionend, marked only by keyCode 229.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
          />
          {/* 44 px on a phone, the tap-target floor; 36 at md, where a pointer aims. */}
          {busy ? (
            <button
              type="button"
              aria-label="stop"
              title="stop the turn"
              className="grid size-11 md:size-9 shrink-0 place-items-center rounded-full border border-current/25 hover:border-red-500 hover:text-red-500"
              onClick={() => stop(slug).catch((e: Error) => alert(`Could not stop the turn: ${e.message}`))}
            >
              <StopIcon className="size-4" />
            </button>
          ) : (
            <button
              aria-label="send"
              title="send (Enter)"
              className="grid size-11 md:size-9 shrink-0 place-items-center rounded-full bg-ink text-paper disabled:opacity-30"
              disabled={!ready || !draft.trim()}
            >
              <SendIcon className="size-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
