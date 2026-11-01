import { useEffect, useRef, useState } from 'react'
import { type RestoreMode, type Timeline, api, json } from './api'
import { reload, touched } from './chatStore'
import { ago } from './format'
import { useChat, useLatest } from './hooks'

/**
 * The project's timeline, which is its git log: one entry per turn, hand edit and
 * restore. Clicking one puts the files back — as a new commit on top, so the snapshot
 * you left is still in the list and going back is itself something you can go back from.
 * It starts at the first build: everything before it is the template (see listSnapshots).
 */
export default function History({ slug, onChange }: { slug: string; onChange: () => void }) {
  const [timeline, setTimeline] = useState<Timeline>({ head: '', snapshots: [] })
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The same signal the code pane follows, for the same reason: a turn is what adds a
  // snapshot, and `writes` is what a restore bumps. No new plumbing.
  const { busy, writes } = useChat(slug)

  useLatest(
    () => api<Timeline>(`/api/projects/${slug}/history`),
    [slug, busy, writes, nonce],
    (d) => {
      setTimeline(d)
      setError(null)
    },
    (e) => setError(e.message),
  )

  useEffect(() => () => clearTimeout(timer.current), [])

  async function restore(sha: string, mode: RestoreMode) {
    setPending(sha)
    setError(null)
    try {
      await json(`/api/projects/${slug}/restore`, 'POST', { sha, mode })
      // Nothing else would tell the code pane: the files moved without a turn. And after
      // a code+chat restore the conversation on screen is the wrong one.
      touched(slug)
      onChange()
      if (mode === 'code+chat') {
        await reload(slug).catch((e: Error) => {
          throw new Error(`Restored, but the conversation shown is still the old one (${e.message}). Reload the page.`)
        })
      }
      // The restore's own picture is taken after it returns, so the entry that just
      // appeared has none for a second or two. One look back, not a poll — and only the
      // latest restore's, or a second one within 3 s would leave the first unclearable.
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setNonce((n) => n + 1), 3000)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="@container flex-1 min-h-0 overflow-y-auto p-3 md:p-4">
      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

      {timeline.snapshots.length === 0 ? (
        <p className="h-full grid place-items-center text-sm opacity-50">
          {error ? 'could not read the timeline' : 'Your first version will appear here.'}
        </p>
      ) : (
        /* One row per version, newest on top — git log's own order. The picture sits on the
           right at a share of the pane's width, capped, and its 16:10 sets the row's
           height, so a row is always as thick as its picture. The text column is
           min-w-0: without it the flex item's automatic minimum is its content, and a long
           unbroken subject would push the picture out of the pane sideways. */
        <ul className="divide-y divide-current/10">
          {timeline.snapshots.map((s) => {
            const current = s.sha === timeline.head
            return (
              <li key={s.sha} className="flex gap-3 @md:gap-4 py-3 @md:py-4 first:pt-0 last:pb-0">
                <div className="flex-1 min-w-0 flex flex-col">
                  <p className="text-base font-medium line-clamp-2 wrap-break-word" title={s.subject}>
                    {s.kind === 'restore' && <span className="opacity-50">⟲ </span>}
                    {s.subject}
                  </p>
                  <p className="mt-0.5 text-[13px] opacity-50 font-mono">
                    {s.sha} · {ago(s.at)}
                  </p>

                  {/* At the foot of the row, level with the picture's bottom edge, where a
                      row taller than its text leaves room. The current version has nothing
                      to restore, so its foot says "current" instead, off the picture: that is
                      128×80 in the narrowest pane, and a badge on it hid its top-left. */}
                  <div className="mt-auto pt-3 flex flex-wrap items-center gap-3">
                    {current ? (
                      <span className="rounded-md bg-emerald-500 text-white px-1.5 py-0.5 text-xs font-medium">
                        current
                      </span>
                    ) : (
                      <>
                        <button
                          className="rounded-lg border border-current/20 px-3 py-2 md:py-1.5 text-sm hover:bg-current/5 disabled:opacity-40"
                          disabled={busy || pending !== null}
                          onClick={() => void restore(s.sha, 'code+chat')}
                          title="restore the files and the conversation that produced them"
                        >
                          {pending === s.sha ? 'restoring…' : 'Restore'}
                        </button>
                        <button
                          className="px-1 py-2 md:py-1.5 text-sm opacity-50 hover:opacity-100 disabled:opacity-20"
                          disabled={busy || pending !== null}
                          onClick={() => void restore(s.sha, 'code')}
                          title="restore the files only, and tell the model they moved"
                        >
                          code only
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="relative shrink-0 self-start w-2/5 max-w-80 aspect-16/10 overflow-hidden rounded-xl border border-current/10 bg-current/5">
                  {s.shot ? (
                    /* Immutable: a given commit's picture can never change, so the sha is
                       the whole cache key. Lazy: one row per version puts most of a long
                       history below the fold, and none of it is fetched until scrolled to. */
                    <img
                      src={`/api/projects/${slug}/screenshot?sha=${s.sha}`}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 w-full h-full object-cover object-top"
                    />
                  ) : (
                    /* The commit outlives its picture — pruned, or taken while the preview
                       was stopped. The entry is still restorable, which is what matters. */
                    <div className="absolute inset-0 grid place-items-center text-sm opacity-30">
                      no picture
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
