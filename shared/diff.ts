/**
 * Line diffs: what a write or an edit row in the chat shows when opened, and the colours the
 * code pane puts over a file the newest turn changed. No imports: the client bundle pulls this
 * file in whole (CodeView), as it does labels.ts.
 */

/** One line: kept, added or removed, numbered in the file it is from — the new one for a kept
 *  or an added line, the old one for a removed line, as Claude Code numbers them. */
export type Line = { t: ' ' | '+' | '-'; n: number; s: string }

/** What one write_file or edit_file call changed, as its row shows it: the changed lines and
 *  three around each run of them, `null` where kept lines are left out between two runs. */
export type Edit = { path: string; added: number; removed: number; lines: (Line | null)[] }

/** Lines without the newline that ends the last one, so a file is not one empty line longer. */
const split = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'))

/**
 * Every line of `after`, and the lines of `before` it no longer has, in order: a run of removed
 * lines before the lines that replace it.
 *
 * A longest common subsequence over the lines between the ones both texts start and end with,
 * which for an edit is a few lines and for a rewrite the whole file.
 * ponytail: O(n·m) over that middle; past 4M line pairs it reports the middle as all removed
 * then all added. Myers' O(ND) if rewrites of files that long ever matter.
 */
export function lineDiff(before: string, after: string): Line[] {
  const a = split(before)
  const b = split(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)

  const out: Line[] = b.slice(0, head).map((s, i) => ({ t: ' ', n: i + 1, s }))
  const w = y.length + 1
  // lcs[i * w + j]: the longest common run of x[i..] and y[j..]. Uint16 is enough under the cap,
  // where the shorter side is at most 2,000 lines.
  const lcs = x.length * y.length <= 4_000_000 ? new Uint16Array((x.length + 1) * w) : null
  const at = (i: number, j: number) => lcs![i * w + j]!
  if (lcs) {
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  }
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (lcs && i < x.length && j < y.length && x[i] === y[j]) out.push({ t: ' ', n: head + ++j, s: x[i++]! })
    else if (i < x.length && (!lcs || j === y.length || at(i + 1, j) >= at(i, j + 1))) out.push({ t: '-', n: head + ++i, s: x[i - 1]! })
    else out.push({ t: '+', n: head + ++j, s: y[j - 1]! })
  }
  for (let k = b.length - tail; k < b.length; k++) out.push({ t: ' ', n: k + 1, s: b[k]! })
  return out
}

/** `lineDiff` as a row shows it: the changes with `around` kept lines either side. */
export function edit(path: string, before: string, after: string, around = 3): Edit {
  const all = lineDiff(before, after)
  const changed = all.map((l) => l.t !== ' ')
  const lines: (Line | null)[] = []
  let skipped = false
  all.forEach((l, i) => {
    if (!changed.slice(Math.max(0, i - around), i + around + 1).includes(true)) skipped = true
    else {
      if (skipped && lines.length) lines.push(null)
      skipped = false
      lines.push(l)
    }
  })
  return {
    path,
    added: all.filter((l) => l.t === '+').length,
    removed: all.filter((l) => l.t === '-').length,
    lines,
  }
}
