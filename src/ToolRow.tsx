import { memo, useState } from 'react'
import { type Edit, api } from './api'
import type { Tool } from './turns'
import { useDisclosure } from './hooks'
import { ChevronIcon } from './icons'

/** `write_file` on `src/Home.tsx` → "write file" in words and the path in monospace: the path is
 *  the part that is code, and the only part a reader scans the list for. */
export function ToolRow({ tool }: { tool: Tool }) {
  return (
    <>
      <span className="opacity-60">{tool.name.replace(/_/g, ' ')}</span>
      {tool.detail && <span className="font-mono"> {tool.detail}</span>}
    </>
  )
}

const lines = (n: number, what: string) => `${what} ${n} line${n === 1 ? '' : 's'}`

/**
 * A write or an edit row that opens, under itself, on what the call changed — as Claude Code
 * shows a Write or an Edit: the lines it removed on red, the lines it added on green, three kept
 * lines around each run of them and ⋯ between two runs, numbered as in the file (the old file's
 * number on a removed line).
 *
 * Fetched when first opened, from what the server kept as the call landed (GET /diffs/:id), so a
 * reload shows the same; a failed fetch is tried again on the next open. Opened like a thinking
 * bubble (useDisclosure), once as it opens and again as the diff lands.
 */
export const WriteRow = memo(function WriteRow({
  slug,
  tool,
  settle,
}: {
  slug: string
  /** Its id is what the server keeps the diff under. */
  tool: Tool
  /** The chat's: re-reads whether it is at its bottom once this has grown under it. */
  settle: () => void
}) {
  /** The diff, or why there is none. */
  const [diff, setDiff] = useState<Edit | string | null>(null)
  const { open, wrapProps, buttonProps, regionProps } = useDisclosure(
    settle,
    () => {
      if (diff !== null && typeof diff !== 'string') return
      setDiff(null)
      api<Edit>(`/api/projects/${slug}/diffs/${encodeURIComponent(tool.id)}`).then(setDiff, (e: Error) => setDiff(e.message))
    },
    diff,
  )

  const width = typeof diff === 'object' && diff ? String(Math.max(0, ...diff.lines.map((l) => l?.n ?? 0))).length : 0

  return (
    <div {...wrapProps} className="scroll-mb-8">
      <button
        {...buttonProps}
        className="flex w-full items-center gap-2 text-left hover:[&>svg]:opacity-100"
      >
        <span className="min-w-0 flex-1 wrap-anywhere">
          <ToolRow tool={tool} />
        </span>
        <ChevronIcon
          className={`size-3.5 shrink-0 opacity-50 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div {...regionProps} className="mt-1.5 mb-1">
        {open &&
          (diff === null ? (
            <p className="text-xs opacity-50">…</p>
          ) : typeof diff === 'string' ? (
            <p className="text-xs opacity-60">{diff}</p>
          ) : (
            <>
              <p className="mb-1 text-xs opacity-60">
                {[diff.added && lines(diff.added, 'Added'), diff.removed && lines(diff.removed, diff.added ? 'removed' : 'Removed')]
                  .filter(Boolean)
                  .join(', ') || 'No change'}
              </p>
              {/* Wrapped, not scrolled sideways: the card is a column of the chat, a phone's
                  included, and a second scroll axis inside the chat's is one too many. */}
              <div
                tabIndex={0}
                className="max-h-[min(50dvh,32rem)] overflow-y-auto overscroll-contain rounded-lg border border-current/10 py-1 font-mono text-xs leading-5"
              >
                {diff.lines.map((l, i) =>
                  l ? (
                    <div
                      key={i}
                      className={`flex ${l.t === '+' ? 'bg-green-500/15' : l.t === '-' ? 'bg-red-500/15' : ''}`}
                    >
                      <span
                        style={{ width: `${width + 2}ch` }}
                        className="shrink-0 select-none pr-[1ch] text-right tabular-nums opacity-45"
                      >
                        {l.n}
                      </span>
                      <span className="w-[2ch] shrink-0 select-none opacity-70">{l.t === ' ' ? '' : l.t}</span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere pr-2">{l.s || ' '}</span>
                    </div>
                  ) : (
                    <div key={i} style={{ paddingLeft: `${width + 1}ch` }} className="select-none opacity-45">
                      ⋯
                    </div>
                  ),
                )}
              </div>
            </>
          ))}
      </div>
    </div>
  )
})
