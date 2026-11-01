/**
 * A turn the server wrote into the conversation, shown as what it is — a note — rather
 * than as a speech bubble from the person.
 *
 * ✎ (server/git.ts noteOutsideEdits) is a sentence for the model, a `git diff
 * --name-status` block, a blank line, then the diff. Collapsed to one line naming the
 * files, because the diff is for the model and most of the time the person already knows
 * what they edited. Opened, it is monospace — the diff was always there, a proportional
 * font just flattened its indentation — and a long line scrolls inside the note, never
 * the chat pane.
 *
 * ⟲ (noteRestore) is one sentence and gets a line, not a disclosure, and so does ⚠ (cutOffNote in
 * server/agent.ts), a reply cut off at its output limit.
 *
 * ◆ (server/design.ts) is the design phase's: what the person answered or picked, for them,
 * then from "Next:" on what the model is to do — three designs' :root blocks and font links
 * after the brief, DESIGN.md's front matter after the pick, the tokens to build with after the
 * approval. That part is for the model, and flattened into
 * the note it was a wall of hex (seen on dev, 2026-09-27), so it is folded like the diff.
 */
export default function Note({
  text,
  settle,
}: {
  text: string
  /** The chat's: re-reads whether it is at its bottom once this has grown under it. */
  settle: () => void
}) {
  if (text.startsWith('◆')) {
    const lines = text.split('\n')
    const next = lines.findIndex((l) => l.startsWith('Next:'))
    const said = (next === -1 ? lines : lines.slice(0, next)).filter((l) => l.trim())
    const told = next === -1 ? [] : lines.slice(next)
    return (
      <div className="rounded-xl bg-current/5 text-sm">
        <p className="px-3 py-2.5 whitespace-pre-line opacity-70 wrap-anywhere">{said.join('\n')}</p>
        {told.length > 0 && (
          <details className="border-t border-current/10">
            <summary
              className="cursor-pointer select-none px-3 py-2 opacity-60"
              onClick={(e) => {
                // Opened by hand and re-pinned, as the ✎ note is below.
                e.preventDefault()
                const note = e.currentTarget.parentElement as HTMLDetailsElement
                note.open = !note.open
                settle()
              }}
            >
              What the builder was told next
            </summary>
            <pre className="overflow-x-auto whitespace-pre-wrap px-3 pb-3 font-mono text-xs leading-snug opacity-70 wrap-anywhere">
              {told.join('\n')}
            </pre>
          </details>
        )}
      </div>
    )
  }
  if (!text.startsWith('✎')) {
    return <p className="rounded-xl bg-current/5 px-3 py-2.5 text-sm opacity-70">{text}</p>
  }

  const [said = '', ...rest] = text.split('\n')
  const blank = rest.indexOf('')
  const status = blank === -1 ? rest : rest.slice(0, blank)
  const diff = blank === -1 ? [] : rest.slice(blank + 1)
  // "M\tsrc/Home.tsx", or "R100\told\tnew" for a rename — the path is the last field.
  const files = status.map((l) => l.split('\t').at(-1) ?? l)
  const named = files.length > 3 ? `${files.slice(0, 3).join(', ')} +${files.length - 3} more` : files.join(', ')

  return (
    <details className="rounded-xl border border-current/10 bg-current/[0.03] text-sm">
      <summary
        className="cursor-pointer select-none px-3 py-3 opacity-80"
        onClick={(e) => {
          // The note arrives as its turn starts, just above it, so a reader following the
          // turn sees it and opens it. That grows the chat without a scroll, the direction
          // rule still counted them as following, and the next send, four times a second
          // while the model reasons, pulled them to the bottom, away from the diff. So the
          // chat re-reads its pin, as when a reasoning panel opens, and it has to see the
          // note open and come before any send. The browser opens a <details> only after
          // this handler, and fires `toggle` a frame later (16 ms, headless Chrome 1243),
          // after a send queued with the tap: onToggle was pulled down 100 times in 100.
          // So the note is opened here, by hand. Enter and Space on the summary arrive as
          // this click too.
          e.preventDefault()
          const note = e.currentTarget.parentElement as HTMLDetailsElement
          note.open = !note.open
          settle()
        }}
      >
        ✎ Changed outside the chat · <span className="font-mono">{named}</span>
      </summary>
      <p className="px-3 pb-2 opacity-60">{said.replace(/^✎\s*/, '')}</p>
      <pre className="overflow-x-auto whitespace-pre px-3 pb-3 font-mono leading-snug">
        {diff.map((line, i) => (
          <div key={i} className={tone(line)}>
            {line || ' '}
          </div>
        ))}
      </pre>
    </details>
  )
}

function tone(line: string): string {
  if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return 'opacity-40'
  if (line.startsWith('@@')) return 'opacity-50'
  if (line.startsWith('+')) return 'text-green-700 dark:text-green-400'
  if (line.startsWith('-')) return 'text-red-700 dark:text-red-400'
  return ''
}
