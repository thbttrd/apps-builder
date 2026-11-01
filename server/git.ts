/**
 * A project's git: a checkpoint per turn, hand edit and restore, and the first build; the
 * timeline those commits are, and putting the files back to one of them; and the note that tells
 * the model what changed outside the chat.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { POD_YAML } from './pod'
import {
  CHAT,
  DIFFS,
  HttpError,
  META,
  META_DIR,
  TURN,
  framesDir,
  isMeta,
  readJson,
  requireProject,
  safeSha,
  writeJson,
} from './project'
import { TRACE } from './trace'

/** Enough history to scroll, few enough that the listing is one cheap git call. */
const HISTORY_LIMIT = 100

export async function headSha(dir: string): Promise<string | undefined> {
  return capture(['git', 'rev-parse', '--short', 'HEAD'], dir)
    .then((s) => s.trim())
    .catch(() => undefined)
}

/**
 * Last edit = last checkpoint. Every turn and every hand edit ends in a commit, so the
 * reflog's mtime is that moment — and reading it is a stat, not a git process spawned per
 * project on a listing the UI refetches after every action. Falls back to the directory
 * for a project whose commit is still running, and to undefined if it vanished mid-listing.
 */
export async function editedAt(dir: string): Promise<string | undefined> {
  const at = await stat(join(dir, '.git/logs/HEAD')).catch(() => stat(dir).catch(() => null))
  return at?.mtime.toISOString()
}

// ── the first build ─────────────────────────────────────────────────────────
// Read from git, like the timeline, so there is no flag in project.json to fall out of step
// with it — and none for a restore to have to decide whether to put back.

/** A project's source: everything but apps-builder's own metadata. */
const SOURCE = ['--', '.', `:(exclude)${META_DIR}`]

/**
 * The subjects of the commits apps-builder makes, which are its records: kindOf, isBuilt,
 * firstBuild and noteOutsideEdits read them back, so a subject written any other way is one
 * they miss. Each is the subject's start; what follows is the turn's number and message, the
 * edited path, the restored snapshot or the design.
 */
export const COMMIT = {
  scaffold: 'scaffold',
  turn: 'turn ',
  edit: 'edit: ',
  restore: 'restore: ',
  /**
   * The commit that puts an approved design into the template (design.ts, approve): src/app.css's
   * tokens, the fonts, the app's name. It changes the app's files and is still not a build — the
   * template in new colours is not the person's app, and the workspace waits for step 1 to show
   * one (the design log › *Starting a project*). So neither isBuilt nor History counts it, and the next
   * turn's outside-edits note starts after it: the model is told what it did in a ◆ note instead.
   */
  design: 'design: ',
} as const

/** The template's "/" page, and the router that puts it there. */
const HOME = 'src/Home.tsx'
const MAIN = 'src/main.tsx'

/**
 * Whether a main.tsx may still show the template's page at "/": it names it — an import, a lazy()
 * — or cannot be read, as one caught mid-write cannot. One that names it no more has routed "/"
 * to a page of its own.
 */
const namesHome = (main: string) => main === '' || /['"]\.\/Home(\.tsx)?['"]/.test(main)

/** The commits that touched `path`, oldest first, as [short sha, subject], design commits aside. */
async function touching(dir: string, path: string): Promise<string[][]> {
  const log = await capture(['git', 'log', '--reverse', '--format=%h%x1f%s', '--', path], dir).catch(() => '')
  return log
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'))
    .filter(([, subject]) => !subject?.startsWith(COMMIT.design))
}

/**
 * Whether the template's "/" page has left "/": the newest commit to touch src/Home.tsx, a design
 * commit aside, is not the scaffold — a turn rewrote or deleted it, or a hand edit or a restore
 * changed it — or main.tsx, as committed, no longer names it. Whatever else a turn wrote — the
 * plan, a lib file, the theme, the shell's name — leaves the template at "/" under new colours,
 * which is not the person's app. Of 66 projects (2026-10-09), 48 rewrote Home.tsx and 6 deleted it
 * for a page named for its job; none left it in place with "/" routed elsewhere, and main.tsx is
 * read so that one would not stay unbuilt for good: no preview, no History.
 *
 * A repo with no scaffold commit — made before there was one — or with no commits at all is
 * built: it opens as it always did. And once a commit has touched the page, nothing makes the
 * project unbuilt again: a restore that puts the page back is itself such a commit.
 */
export async function isBuilt(dir: string): Promise<boolean> {
  const newest = await capture(['git', 'log', '-1', '--format=%s', '--invert-grep', `--grep=^${COMMIT.design}`, '--', HOME], dir).catch(() => '')
  if (newest.trim() !== COMMIT.scaffold) return true
  return !namesHome(await capture(['git', 'show', `HEAD:${MAIN}`], dir).catch(() => ''))
}

/**
 * Whether the template's "/" page has left "/" on disk since the last commit: Home.tsx rewritten
 * or deleted, or main.tsx naming it no more. That is the first build seen while its turn is still
 * running, before the turn's commit makes isBuilt true — or left so by a turn whose process died
 * before that commit, until the next turn commits it. The listing asks as well that the running
 * preview serve what "/" now shows (pageServes in previews.ts).
 */
export async function pageReplaced(dir: string): Promise<boolean> {
  const diff = await capture(['git', 'diff', '--name-only', 'HEAD', '--', HOME], dir).catch(() => '')
  return diff.trim() !== '' || !namesHome(await Bun.file(join(dir, MAIN)).text().catch(() => ''))
}

/**
 * The commit of the first build — the oldest after the scaffold to touch src/Home.tsx, a design
 * commit aside, or, where main.tsx routed "/" elsewhere and left the page as it was, the oldest
 * after the scaffold to touch main.tsx — which is where History starts. null while isBuilt is
 * false, and undefined when the repo has no scaffold commit to count from, where nothing is cut.
 */
async function firstBuild(dir: string): Promise<string | null | undefined> {
  const [scaffold, first] = await touching(dir, HOME)
  if (scaffold?.[1] !== COMMIT.scaffold) return undefined
  if (first) return first[0]
  return (await isBuilt(dir)) ? ((await touching(dir, MAIN))[1]?.[0] ?? null) : null
}

// ── snapshots ───────────────────────────────────────────────────────────────
// Every turn, every hand edit and every restore is one commit, so git already holds the
// timeline. Nothing here keeps a second copy of it.

export type Snapshot = {
  sha: string
  at: string
  subject: string
  kind: 'scaffold' | 'turn' | 'edit' | 'restore' | 'other'
  /** Whether a picture of this commit survives. Old ones are pruned; the commit is not. */
  shot: boolean
}

/** Parsed from our own commit messages. Deliberately stringly-typed: a `kind` column kept
 *  anywhere else would be a second record to fall out of step with the first. */
function kindOf(subject: string): Snapshot['kind'] {
  if (subject === COMMIT.scaffold) return 'scaffold'
  return (['turn', 'edit', 'restore'] as const).find((k) => subject.startsWith(COMMIT[k])) ?? 'other'
}

/** GET /history: the snapshots, newest first, and the commit the files are at. */
export type Timeline = { head: string; snapshots: Snapshot[] }

export async function listSnapshots(slug: string): Promise<Timeline> {
  const dir = await requireProject(slug)
  // %x1f, the unit separator: a commit subject can contain anything except that.
  // The catch is for a project made before commit-per-turn existed — `git log` on a repo
  // with no commits exits non-zero, and an empty timeline is the honest answer.
  const log = await capture(
    ['git', 'log', `-n${HISTORY_LIMIT}`, '--format=%h%x1f%cI%x1f%s'],
    dir,
  ).catch(() => '')
  const frames = new Set(await readdir(framesDir(slug)).catch(() => []))

  const snapshots = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', at = '', subject = ''] = line.split('\x1f')
      return { sha, at, subject, kind: kindOf(subject), shot: frames.has(`${sha}.png`) }
    })
  // Nothing from before the first build: the scaffold, and the turns that only asked or wrote
  // the spec and the plan, are all pictures of the template. `head` stays the real HEAD, so
  // an unbuilt project has an empty timeline and still knows where it is.
  const cut = await firstBuild(dir)
  const at = cut ? snapshots.findIndex((s) => s.sha === cut) : -1
  const shown = cut === null ? [] : at >= 0 ? snapshots.slice(0, at + 1) : snapshots
  return { head: snapshots[0]?.sha ?? '', snapshots: shown }
}

export type RestoreMode = 'code' | 'code+chat'

/**
 * Put the project back to how it was at `sha`, as a new commit on top. True when that changed
 * anything: then the app on disk is not the app last photographed (the route takes the picture).
 *
 * Never `git reset --hard`: the snapshot you left is still in the log, still has its
 * picture, and is still one click away. Going back has to be as undoable as going
 * forward, or nobody can afford to use it.
 */
export async function restoreSnapshot(
  slug: string,
  sha: string,
  mode: RestoreMode,
): Promise<boolean> {
  const dir = await requireProject(slug)
  safeSha(sha)

  // Only somewhere this project has actually been. A commit id from another repo, or a
  // dangling one, is a 404 — not something to check out. capture() rather than run() for
  // the one reason: a sha that is not in the log is an ordinary 404, and run() inherits
  // stderr, so every one of them would print a git `fatal:` into the journal.
  const known = await capture(['git', 'merge-base', '--is-ancestor', sha, 'HEAD'], dir).then(
    () => true,
    () => false,
  )
  if (!known) throw new HttpError(404, `no snapshot "${sha}" in "${slug}"`)

  const subject = await capture(['git', 'log', '-1', '--format=%s', sha], dir)
    .then((s) => s.trim())
    .catch(() => sha)

  /*
    Read aside, restore the whole tree, write back.

    Not `git checkout <sha> -- .`: that writes the paths present in <sha> and leaves
    behind everything added after it, so restoring past a turn that created a file keeps
    the file. read-tree --reset makes the work tree *equal* the tree, deletions included,
    without moving HEAD.

    project.json is held in both modes on purpose: it carries usd and turns, and the money
    really was spent. The tally is a fact about the world, not about the code.
  */
  const keep = mode === 'code' ? [META, CHAT] : [META]
  const held = await Promise.all(
    keep.map(async (p) => ({
      p,
      bytes: await Bun.file(join(dir, p))
        .arrayBuffer()
        .catch(() => null),
    })),
  )

  await run(['git', 'read-tree', '-u', '--reset', sha], dir)
  // Bun.write creates parents, which matters: restoring to the scaffold removes
  // .apps-builder/ entirely before these go back.
  for (const { p, bytes } of held) if (bytes) await Bun.write(join(dir, p), bytes)
  // The files are no longer what the last turn left, so the code pane stops colouring its changes.
  await rm(join(dir, TURN), { force: true })

  // Restoring to where you already are is not an event. checkpoint() would decline to
  // commit anyway; this also stops a code-only restore leaving a note about nothing.
  if (!(await capture(['git', 'status', '--porcelain', ...UNCOMMITTED], dir)).trim()) return false

  if (mode === 'code') await noteRestore(dir, sha, subject)

  await checkpoint(
    dir,
    `${COMMIT.restore}${subject} (${sha}, ${mode === 'code' ? 'code only' : 'code + chat'})`,
  )
  return true
}

/**
 * A code-only restore moves the files out from under the model: its context still claims
 * it wrote what is no longer on disk, and nothing makes it go and look. So it is told.
 *
 * As a user turn, not a system one — the client renders user and assistant messages only,
 * so a system note would steer the model while being invisible to the person who caused
 * it. It is also honestly what it is: an instruction the next turn has to obey.
 */
async function noteRestore(dir: string, sha: string, subject: string): Promise<void> {
  const path = join(dir, CHAT)
  const messages = await readJson<unknown[] | null>(path, null)
  // No conversation, nothing to fall out of step with it.
  if (!messages) return
  messages.push({
    role: 'user',
    content:
      `⟲ The project files were restored to "${subject}" (${sha}). Anything written after ` +
      `that point is no longer on disk — read the files before assuming what they contain.`,
  })
  await writeJson(path, messages)
}

/**
 * What changed in the project since the model last saw it, as a note for the start of a
 * turn — or null when nothing did. Never throws: a turn is worth more than its note.
 *
 * The model's context holds every file as it last wrote or read it, and it trusts that:
 * measured 2026-09-22, a turn rewrote Home.tsx from memory without reading it and silently
 * dropped a component added by hand in between. noteRestore() covers the code-only restore;
 * this covers everything else — a save from the code pane, an edit in code-server, a script.
 *
 * "Last saw" is the newest turn, scaffold, restore or design commit: after any of those the files
 * and the conversation agree (a code-only restore has already left its own note, and a design
 * commit's is the ◆ note after the approval). Anything since —
 * `edit:` commits, and uncommitted changes, which are committed here first so they are both
 * diffable and undoable like any other edit — is what the model does not know about.
 *
 * An edit made on disk *while* a turn runs is split out of that turn's commit into one of
 * its own, after it (see chat() in agent.ts), so it is noted here at the next turn.
 */
export async function noteOutsideEdits(dir: string): Promise<string | null> {
  try {
    // Not .apps-builder, in the check or the commit: a settings change is not an edit the
    // model needs telling about. Committing it here put one `edit: outside the chat` in
    // History per settings change, or folded it into a hand edit's. The next turn's own
    // commit takes it (see chat() in agent.ts) — unless a save from the code pane or a
    // restore, both of which commit everything, comes first.
    if ((await capture(['git', 'status', '--porcelain', ...SOURCE], dir)).trim()) {
      await checkpoint(dir, `${COMMIT.edit}outside the chat`, (p) => !isMeta(p))
    }
    // A design commit too: code applied the design the person approved, and the next turn's ◆
    // note says so (design.ts) — "changed outside this chat" would send the model to read it.
    const anchor = (
      await capture(
        ['git', 'log', '-1', '--format=%H', '-E', `--grep=^(${COMMIT.turn}[0-9]|${COMMIT.restore}|${COMMIT.scaffold}$|${COMMIT.design})`],
        dir,
      )
    ).trim()
    if (!anchor) return null
    const names = (await capture(['git', 'diff', '--name-status', anchor, 'HEAD', ...SOURCE], dir)).trim()
    if (!names) return null
    const diff = await capture(['git', 'diff', '--no-color', '-U2', anchor, 'HEAD', ...SOURCE], dir)
    return (
      `✎ These files were changed outside this chat since your last turn — by hand in the code ` +
      `pane or by another editor. Your memory of them is out of date; read a file before ` +
      `rewriting it, and keep these changes unless asked to undo them.\n${names}\n\n` +
      (diff.length <= NOTE_DIFF_MAX ? diff.trim() : '(the diff is too long to include — read the files)')
    )
  } catch (e) {
    console.error(`[outside edits ${dir}]`, e)
    return null
  }
}

/** ~1k tokens. A bigger diff is a rewrite, and the files say it better than a patch. */
const NOTE_DIFF_MAX = 4000

/**
 * Everything but writeJson's temporaries, which live between a write and its rename — a
 * status that listed one handed `git add` a path gone by then: exit 128, and a turn's whole
 * commit lost (43 of 200 checkpoints racing a loop of settings saves); a plain `add -A`
 * committed it — and the trace, which a restore must not rewind (trace.ts), and the pod's
 * spec, rewritten at every start (pod.ts). Nor the diffs, for the trace's reason: a code-only
 * restore keeps the chat, and its rows would lose what they changed. Nor TURN, the newest
 * turn's alone, which a restore empties.
 */
const UNCOMMITTED = [
  '--',
  '.',
  `:(exclude)${META_DIR}/*.tmp`,
  `:(exclude)${TRACE}`,
  `:(exclude)${POD_YAML}`,
  `:(exclude)${DIFFS}`,
  `:(exclude)${TURN}`,
]

/**
 * Author checkpoints as the tool. The host user's gitconfig may say anything or nothing,
 * and a missing user.email is a hard failure in git, not a warning.
 */
const GIT_ID = ['-c', 'user.name=apps-builder', '-c', 'user.email=apps-builder@localhost']

/**
 * Commit everything in a project, or do nothing if nothing changed. Returns the short
 * SHA, or null when there was nothing to commit or git failed.
 *
 * `only` narrows it to the changed paths it accepts — how a turn commits just the files
 * it wrote, leaving anything else that changed meanwhile for a commit of its own.
 *
 * Never throws. A checkpoint is worth less than the work it is checkpointing, so a git
 * problem must not take down the turn that produced the files.
 */
export async function checkpoint(
  dir: string,
  message: string,
  only?: (path: string) => boolean,
): Promise<string | null> {
  try {
    // -z and every untracked file by name: the paths are matched one by one against
    // `only`, so a new directory must not arrive as the single entry "src/pages/".
    const status = await capture(['git', 'status', '--porcelain', '-z', '--untracked-files=all', ...UNCOMMITTED], dir)
    if (!status) return null
    if (only) {
      // "XY path" per entry. Nothing is ever staged between checkpoints, so there are no
      // rename entries and their trailing old-path field to trip over.
      const paths = status.split('\0').filter(Boolean).map((e) => e.slice(3)).filter(only)
      if (!paths.length) return null
      // Literal: a model-chosen name like src/[id].tsx is a filename here, not a glob.
      await run(['git', '--literal-pathspecs', 'add', '-A', '--', ...paths], dir)
    } else await run(['git', 'add', '-A', ...UNCOMMITTED], dir)
    await run(['git', ...GIT_ID, 'commit', '-q', '-m', message], dir)
    return (await capture(['git', 'rev-parse', '--short', 'HEAD'], dir)).trim()
  } catch (e) {
    console.error(`[checkpoint ${dir}]`, e)
    return null
  }
}

async function capture(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} exited non-zero`)
  return out
}

export async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`)
}
