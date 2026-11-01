import { useEffect, useState } from 'react'
import type { Doing } from './api'
import type { Live } from './chatStore'

/**
 * The foot of the live turn, under what it has thought and done so far: what the model is doing and for how
 * long. The reasoning itself is Thinking.tsx's, so it can outlive the turn.
 *
 * The orb is not decoration. It pulses while the stream is delivering, and the server's
 * `: ping` every 15 s counts, so a model that is silent upstream (a write_file this
 * provider sends in one piece) still reads as a live connection. Two missed pings is not
 * the model being slow; it is the connection. Then the orb goes amber and still, and the
 * line says so, instead of an animation spinning over a socket that died.
 */
const SILENT_MS = 35_000

const SAYS: Record<Doing, string> = {
  waiting: 'waiting for the model',
  thinking: 'thinking',
  writing: 'writing',
  running: 'running',
  saving: 'saving',
}

export default function Activity({ live, heard, grew }: { live: Live; heard: number; grew: () => void }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const quiet = now - heard > SILENT_MS
  // The note adds lines under what the chat last scrolled to, and of everything on this
  // line it is the part that has to be seen. It grows without `turns` or the activity
  // changing, so nothing else would ask the chat to follow it.
  useEffect(() => {
    if (quiet) grew()
  }, [quiet, grew])

  return (
    <div className="whitespace-normal text-sm">
      <p className="flex items-center gap-2">
        <span aria-hidden className="relative grid size-3 shrink-0 place-items-center">
          {!quiet && <span className="absolute inset-0 rounded-full bg-emerald-500/50 animate-ping" />}
          <span
            className={`size-2 rounded-full ${quiet ? 'bg-amber-500' : 'bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/70'}`}
          />
        </span>
        {/* The only live part, and only the label. The clock ticks every second, and the
            reasoning under this line moves four times a second; a live region around
            either would read out the whole turn. */}
        <span role="status" className="min-w-0 truncate opacity-70">
          {SAYS[live.doing]}
          {live.what && <span className="font-mono"> {live.what}</span>}
          {quiet && <span className="sr-only">, and the connection may have dropped</span>}
        </span>
        <span className="ml-auto shrink-0 font-mono tabular-nums opacity-45">{clock(now - live.since)}</span>
      </p>
      {quiet && (
        <p className="mt-1 text-amber-700 dark:text-amber-400">
          Nothing from the server for {clock(now - heard)}. The connection may have dropped; the
          turn carries on without it, and a reload picks it back up.
        </p>
      )}
    </div>
  )
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
