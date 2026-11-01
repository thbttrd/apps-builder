import { join } from 'node:path'

/**
 * What this instance *is*: the version it declares, the commit it was built from, and
 * CHANGELOG.md parsed into entries. The About screen is the only consumer, and it asks
 * the server rather than reading a constant compiled into the bundle — a build-time
 * constant would be right only until someone served the dist of one commit from the
 * tree of another.
 *
 * Paths resolve from this file, not the cwd: the staging unit's WorkingDirectory is a
 * symlink to the release, and `bun run release` is run from wherever the shell is.
 */
const ROOT = join(import.meta.dir, '..')
export const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md')
export const PACKAGE_PATH = join(ROOT, 'package.json')

/** Pinned in staging's manifest by the release job; unset everywhere else. */
export const GIT_SHA = Bun.env.GIT_SHA ?? 'dev'
export const STARTED_AT = new Date().toISOString()

/** A paragraph, or a run of bullets. Real entries contain both, so both survive here. */
export type Block = { kind: 'text'; text: string } | { kind: 'list'; items: string[] }

/** One `### Added` group. `title` is null for content written before any `###`. */
export type Section = { title: string | null; blocks: Block[] }

/** One `## [x.y.z] — date`. `version` and `date` are null for `## [Unreleased]`. */
export type Entry = { version: string | null; date: string | null; sections: Section[] }

export type VersionInfo = {
  /** package.json — the release this tree declares itself to be. */
  version: string
  /** package.json's description: the one line saying what this is. Null if unreadable. */
  description: string | null
  /** The commit this is running: $GIT_SHA on staging, HEAD anywhere else. */
  sha: string
  /** `git describe`. The only one of the three that can say "and twelve commits past it,
   *  with uncommitted changes". Null where git cannot answer. */
  describe: string | null
  startedAt: string
  /** Newest first, exactly as CHANGELOG.md orders them. */
  entries: Entry[]
}

/**
 * `## [0.3.0] — 2026-09-22`, or `## [Unreleased]`. Any of the three dashes: the file is
 * written by hand, and an em dash that had to be typed exactly would be a trap.
 */
const ENTRY = /^##\s+\[([^\]]+)\]\s*(?:[—–-]\s*(\S+))?\s*$/
const SECTION = /^###\s+(.+?)\s*$/

/**
 * CHANGELOG.md → entries. Everything above the first `## [` is the preamble and is
 * dropped: it explains the file to whoever edits it, not to whoever opens the About
 * screen. A line that is neither blank nor a bullet continues whatever came before it,
 * so a bullet or a paragraph may wrap in the file and still arrive here in one piece.
 */
export function parseChangelog(text: string): Entry[] {
  const entries: Entry[] = []
  let entry: Entry | null = null
  let section: Section | null = null
  /** The block still being written into. A blank line is what closes it. */
  let open: Block | null = null

  for (const line of text.split('\n')) {
    const heading = ENTRY.exec(line)
    if (heading) {
      const name = heading[1] ?? ''
      const released = name.toLowerCase() !== 'unreleased'
      entry = { version: released ? name : null, date: released ? (heading[2] ?? null) : null, sections: [] }
      entries.push(entry)
      section = null
      open = null
      continue
    }
    if (!entry) continue // preamble

    const group = SECTION.exec(line)
    if (group) {
      section = { title: group[1] ?? null, blocks: [] }
      entry.sections.push(section)
      open = null
      continue
    }

    const text = line.trim()
    if (!text) {
      open = null
      continue
    }

    // Content before the first `###` still has to land somewhere: v0.3.0 opens with a
    // paragraph, and v0.1.0 is one bullet with no groups at all.
    if (!section) {
      section = { title: null, blocks: [] }
      entry.sections.push(section)
    }

    if (text.startsWith('- ')) {
      const item = text.slice(2).trim()
      if (open?.kind === 'list') open.items.push(item)
      else {
        open = { kind: 'list', items: [item] }
        section.blocks.push(open)
      }
    } else if (open?.kind === 'list') {
      // A wrapped bullet, never a new one: join it back onto the item above.
      const last = open.items.pop() ?? ''
      open.items.push(`${last} ${text}`)
    } else if (open?.kind === 'text') {
      open.text = `${open.text} ${text}`
    } else {
      open = { kind: 'text', text }
      section.blocks.push(open)
    }
  }

  // `### Added` with nothing under it says nothing; drop it rather than render a bare
  // heading. An entry left with no sections is `## [Unreleased]` at a release commit —
  // kept, because the release script has to be able to find it and say it is empty.
  for (const e of entries) e.sections = e.sections.filter((s) => s.blocks.length > 0)
  return entries
}

async function git(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() || null : null
  } catch {
    // git absent, or this is not a checkout at all — a tarball deploy still has a version.
    return null
  }
}

/**
 * Missing or unparseable reads as {}. That is a broken deploy, and a screen that says
 * "unknown" is worth more there than one that fails to render.
 */
async function readPackage(): Promise<{ version?: unknown; description?: unknown }> {
  try {
    return (await Bun.file(PACKAGE_PATH).json()) as { version?: unknown; description?: unknown }
  } catch {
    return {}
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** package.json's version, or "unknown" if it cannot be read — never a guess. */
export async function declaredVersion(): Promise<string> {
  return text((await readPackage()).version) ?? 'unknown'
}

/**
 * Read per request, never memoised: the dev instance *is* the working tree, and a cached
 * `describe` would go on claiming a release the tree moved past ten commits ago. One
 * `git describe` and one small file, on a screen that is opened by hand.
 */
export async function versionInfo(): Promise<VersionInfo> {
  const [pkg, describe, head, changelog] = await Promise.all([
    readPackage(),
    git(['describe', '--tags', '--match', 'v*', '--always', '--dirty']),
    git(['rev-parse', 'HEAD']),
    Bun.file(CHANGELOG_PATH)
      .text()
      .catch(() => ''),
  ])

  return {
    version: text(pkg.version) ?? 'unknown',
    description: text(pkg.description),
    sha: GIT_SHA === 'dev' ? (head ?? 'dev') : GIT_SHA,
    describe,
    startedAt: STARTED_AT,
    entries: parseChangelog(changelog),
  }
}
