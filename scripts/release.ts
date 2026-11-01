/**
 * Cut a release: package.json, CHANGELOG.md and the `vX.Y.Z` tag move together, or
 * nothing moves.
 *
 *   bun run release                       what the next one would be, and what is in it
 *   bun run release minor
 *   bun run release 0.4.0 --dry-run
 *   bun run release patch --any-branch    a hotfix cut off an older branch
 *
 * They had already drifted before this existed — the tree said 0.1.0 while staging ran
 * v0.3.0 — which is the whole argument for one command that cannot do half of it.
 *
 * Pushing the tag *is* the deploy: staging polls origin for the highest `v*` every minute
 * (the author's release job). This script does not build or check first. `bun run check`
 * needs a real node for the preview processes and takes minutes, and the deploy already
 * fails safe — it tests both images before it pushes them and pins nothing in the cluster's GitOps repo
 * if they fail. A release that does not build stops there, not here.
 */
import { join } from 'node:path'
import {
  CHANGELOG_PATH,
  PACKAGE_PATH,
  declaredVersion,
  parseChangelog,
  type Entry,
} from '../server/version'

const ROOT = join(import.meta.dir, '..')
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const MARKER = '## [Unreleased]'
const STAGING = 'https://apps-builder.staging.example.net'

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`)
  process.exit(1)
}

async function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { ok: (await proc.exited) === 0, out: out.trim(), err: err.trim() }
}

/** For the steps where a git failure is not an outcome this script has an answer to. */
async function must(...args: string[]): Promise<string> {
  const r = await git(args)
  if (!r.ok) die(`git ${args.join(' ')}\n    ${r.err || r.out}`)
  return r.out
}

// ── what was asked for ────────────────────────────────────────────────────

let dryRun = false
let anyBranch = false
let target: string | undefined
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') dryRun = true
  else if (arg === '--any-branch') anyBranch = true
  else if (arg === '-h' || arg === '--help') target = ''
  else if (target === undefined) target = arg
  else die(`unexpected argument: ${arg}`)
}

const current = await declaredVersion()
if (!SEMVER.test(current)) die(`package.json version "${current}" is not X.Y.Z`)

const raw = await Bun.file(CHANGELOG_PATH).text()
const unreleased = parseChangelog(raw).find((e) => e.version === null)
if (!unreleased) die(`${CHANGELOG_PATH} has no "${MARKER}" section`)
const items = bullets(unreleased)

// No argument is not a request to guess. Print the state and the three candidates, and
// exit non-zero so a script that forgot the argument does not read as a release.
if (target === undefined || target === '') {
  console.log(`\n  apps-builder ${current}\n`)
  console.log(indent(wrap(entryText(unreleased) || '(nothing written under [Unreleased])', 76), 2))
  console.log(
    `\n  next:  patch → ${bump(current, 'patch')}   minor → ${bump(current, 'minor')}   major → ${bump(current, 'major')}`,
  )
  console.log(`\n  bun run release <major|minor|patch|X.Y.Z> [--dry-run] [--any-branch]\n`)
  console.log(`  While pre-1.0: minor is a visible change, patch is fixes only.\n`)
  process.exit(2)
}

const next = target === 'major' || target === 'minor' || target === 'patch' ? bump(current, target) : target
if (!SEMVER.test(next)) die(`"${target}" is not major, minor, patch, or X.Y.Z`)
if (!after(next, current)) die(`${next} does not come after ${current}`)
const tag = `v${next}`

// ── the refusals ──────────────────────────────────────────────────────────

if ((await must('status', '--porcelain')) !== '') {
  die('the working tree is not clean — a release has to be exactly what was reviewed')
}

const branch = await must('rev-parse', '--abbrev-ref', 'HEAD')
if (branch === 'HEAD') die('detached HEAD — check out a branch first')
if (branch !== 'main' && !anyBranch) {
  die(`on "${branch}", not main — work reaches main by merge and the tag is cut from there.\n    A hotfix off an older branch is what --any-branch is for.`)
}

// --force, because the deploy script fetches tags the same way: a tag that was moved on
// origin has to win here too, or this refuses a version that staging would happily take.
await must('fetch', '--quiet', '--prune', '--tags', '--force', 'origin')

const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
if (remote.ok) {
  const behind = await must('rev-list', '--count', `HEAD..origin/${branch}`)
  if (behind !== '0') {
    die(`${branch} is ${behind} commit(s) behind origin — pull first, or the tag misses them`)
  }
}

if (items.length === 0) {
  die(`${MARKER} has no "- " bullets.\n    Write the entry first: it is the tag's message and the About screen's text.`)
}
if ((await git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])).ok) {
  die(`${tag} already exists locally`)
}
if ((await must('ls-remote', '--tags', 'origin', tag)) !== '') die(`${tag} already exists on origin`)

// ── the rewrite ───────────────────────────────────────────────────────────

const date = new Date().toISOString().slice(0, 10)
const bodyAt = raw.indexOf(MARKER) + MARKER.length
const nextAt = raw.indexOf('\n## ', bodyAt)
const body = raw.slice(bodyAt, nextAt === -1 ? undefined : nextAt).trim()
const older = nextAt === -1 ? '' : raw.slice(nextAt + 1)
const changelog = `${raw.slice(0, bodyAt)}\n\n## [${next}] — ${date}\n\n${body}\n\n${older}`.trimEnd() + '\n'

// The splice is string surgery on a file a human wrote. Parse the result back and insist
// it says the same thing, so a heading this did not expect fails here rather than on the
// About screen of whatever staging is about to run.
const written = parseChangelog(changelog).find((e) => e.version === next)
if (!written || bullets(written).length !== items.length) {
  die(`the rewritten ${CHANGELOG_PATH} does not parse back to the same entry — nothing written`)
}
if (bullets(parseChangelog(changelog).find((e) => e.version === null) ?? blank()).length !== 0) {
  die(`${MARKER} would not be empty after the move — nothing written`)
}

const pkg = await Bun.file(PACKAGE_PATH).text()
const versionLine = `"version": "${current}"`
if (pkg.split(versionLine).length !== 2) die(`package.json has no single ${versionLine} to move`)

const title = summary(unreleased, next)
const message = `${title}\n\n${body}\n`

console.log(`\n  ${current} → ${next}   ${tag}   ${date}   on ${branch}\n`)
console.log(indent(wrap(entryText(unreleased), 76), 2))
console.log(`\n  tag message opens: ${title}`)

if (dryRun) {
  console.log(`\n  --dry-run: nothing written.\n`)
  process.exit(0)
}

await Bun.write(CHANGELOG_PATH, changelog)
await Bun.write(PACKAGE_PATH, pkg.replace(versionLine, `"version": "${next}"`))

await must('add', '--', CHANGELOG_PATH, PACKAGE_PATH)
await must('commit', '-q', '-m', `release: ${tag}`, '-m', body)
await must('tag', '-a', tag, '-m', message)

// Branch before tag, always: a tag on origin whose commit is not there is a deploy that
// fetches a sha it cannot check out.
for (const ref of [branch, tag]) {
  const push = await git(['push', 'origin', ref])
  if (!push.ok) {
    console.error(`\n  ✗ push of ${ref} failed:\n    ${push.err || push.out}\n`)
    if (ref === branch) {
      console.error(`  ${tag} is committed and tagged locally, and nothing is deployed.`)
      console.error(`  Retry:  git push origin ${branch} && git push origin ${tag}`)
      console.error(`  Undo:   git tag -d ${tag} && git reset --hard HEAD~1\n`)
    } else {
      // The release commit is on origin already: undoing it here would leave the branch behind
      // what everyone else has. Only the tag is missing, and staging deploys from the tag.
      console.error(`  The release commit is on origin; ${tag} is tagged only here, so nothing is deployed.`)
      console.error(`  Retry:  git push origin ${tag}\n`)
    }
    process.exit(1)
  }
}

console.log(`\n  ✓ ${tag} pushed.`)
console.log(`    the release job takes it within a minute; DEPLOYED on the dev server`)
console.log(`    records what it took, and ${STAGING} shows it on About.\n`)

// ── helpers ───────────────────────────────────────────────────────────────

function bump(from: string, kind: 'major' | 'minor' | 'patch'): string {
  const m = SEMVER.exec(from) ?? die(`version "${from}" is not X.Y.Z`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Strictly after, field by field — "0.10.0" is after "0.9.0", which a string compare says it is not. */
function after(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => (SEMVER.exec(v) ?? die(`version "${v}" is not X.Y.Z`)).slice(1).map(Number))
  for (let i = 0; i < 3; i++) {
    const [l, r] = [x?.[i] ?? 0, y?.[i] ?? 0]
    if (l !== r) return l > r
  }
  return false
}

function bullets(entry: Entry): string[] {
  return entry.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === 'list' ? b.items : [])))
}

function blank(): Entry {
  return { version: null, date: null, sections: [] }
}

/** The entry as lines, for the terminal — the same shape the About screen renders. */
function entryText(entry: Entry): string {
  return entry.sections
    .map((s) => {
      const blocks = s.blocks.map((b) =>
        b.kind === 'list' ? b.items.map((i) => `- ${i}`).join('\n') : b.text,
      )
      return [s.title, ...blocks].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

/**
 * `git tag -n1` prints one line, so the entry's opening paragraph — the house style for a
 * release worth a sentence — becomes that line. An entry that opens straight into bullets
 * gets the bare tag rather than an invented summary, and so does a first sentence too long
 * to be one.
 */
function summary(entry: Entry, version: string): string {
  const lead = entry.sections[0]?.blocks[0]
  if (lead?.kind !== 'text') return `v${version}`
  const stop = lead.text.indexOf('. ')
  const sentence = (stop === -1 ? lead.text : lead.text.slice(0, stop)).replace(/\.$/, '')
  return sentence.length > 72 ? `v${version}` : `v${version} — ${sentence}`
}

/**
 * Wrapped for a terminal. The parser dissolves the file's own line breaks, which is right
 * for a screen that reflows and unreadable in an 80-column window; a bullet's continuation
 * is hung under its text so the list still reads as a list.
 */
function wrap(text: string, width: number): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const hang = line.startsWith('- ') ? '  ' : ''
    let row = ''
    for (const word of line.split(' ')) {
      if (row && `${row} ${word}`.length > width) {
        out.push(row)
        row = hang + word
      } else row = row ? `${row} ${word}` : word
    }
    out.push(row)
  }
  return out.join('\n')
}

function indent(text: string, by: number): string {
  const pad = ' '.repeat(by)
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n')
}
