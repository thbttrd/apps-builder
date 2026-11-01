/**
 * Where a project lives, and what apps-builder keeps in it: the projects directory and a
 * project's place in it, its metadata under .apps-builder/ and the JSON that holds it, where its
 * pictures go, and its source files as the tools and the code pane see them.
 */
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { SERVICES, type Service } from './pod'
import { type Params, cleanParams } from '../shared/params'
import { type Settings, isBudget, isGate } from '../shared/settings'
import { slugify } from '../shared/slug'

export const PROJECTS_DIR =
  Bun.env.AB_PROJECTS_DIR ?? join(Bun.env.HOME ?? '.', 'Deployments/apps-builder/projects')

/**
 * Preview screenshots live beside the projects, never inside one: checkpoint() runs
 * `git add -A`, so a PNG in the project directory would land a fresh blob in its history
 * on every single turn. listProjects() lists only names that are their own slugify(), and
 * `.shots` is not one, so this stays invisible to it.
 *
 *   .shots/<slug>.png        the gallery card — a hardlink to the newest frame
 *   .shots/<slug>/<sha>.png  one frame per checkpoint, which is what the timeline shows
 */
const SHOTS = '.shots'

/** Per-project settings (settings.ts), the running cost tally, and what the model has added
 *  beside the preview (add_service). Absent file means all defaults. */
/** dataId: names the app's database volume on the cluster (kube.ts), set at its first add_service; a
 *  slug can be renamed, a volume can't. */
export type Meta = Settings & { usd: number; turns: number; services?: Service[]; dataId?: string }

/** apps-builder's own files in a project: its metadata, never the app's source (SKIP). */
export const META_DIR = '.apps-builder'
/** Whether a path, relative to the project, is one of META_DIR's. */
export const isMeta = (path: string) => path.startsWith(`${META_DIR}/`)
export const META = join(META_DIR, 'project.json')
/** The conversation, as the model sees it: ModelMessage[], reasoning and tool calls included. */
export const CHAT = join(META_DIR, 'chat.json')
/** What the app is for, as the model last saved it with save_spec (tools.ts). */
export const SPEC_FILE = join(META_DIR, 'spec.json')
/** The steps of the build, as the model last saved them with update_plan (tools.ts). */
export const PLAN_FILE = join(META_DIR, 'plan.json')
/**
 * What the newest turn found in each file before its first change to it, as { path: text }:
 * the code pane colours what the turn changed against it (GET /file's `was`). Emptied as a
 * turn starts (chat() in agent.ts), and by a restore; a save from the code pane drops its file.
 */
export const TURN = join(META_DIR, 'turn.json')
/** TURN, or nothing when there is none or it cannot be read: colours are not worth a failure. */
export const turnBefores = (dir: string): Promise<Record<string, unknown>> =>
  Bun.file(join(dir, TURN))
    .json()
    .catch(() => ({}))
/** What each write_file and edit_file call changed, one file per call id (shared/diff.ts). */
export const DIFFS = join(META_DIR, 'diffs')

/** Where a call's diff is kept, or null for an id that cannot be a file name. Every provider's
 *  ids are letters, digits, _ and - (call_…, toolu_bdrk_…, chatcmpl-tool-…). */
export const diffPath = (dir: string, id: string) => (/^[\w-]{1,128}$/.test(id) ? join(dir, DIFFS, `${id}.json`) : null)

/**
 * project.json and chat.json are read outside any queue — listProjects, the start and end of
 * a turn — so a write replaces the file whole: under a temporary name beside it, then
 * rename(), which is atomic. And the read has no exists() probe: Bun.file keeps the size
 * exists() saw, so even a longer file renamed in between parsed cut off at the old length.
 * Measured 2026-09-25 over 10 000 pairs of saves each answered with a listing: 728 torn
 * reads written in place, 4 with only the read changed, none with both.
 */
export async function readJson<T>(path: string, absent: T): Promise<T> {
  return Bun.file(path)
    .json()
    .catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return absent
      throw e
    })
}

/**
 * Never creates a directory, so a project that has moved away fails here rather than
 * reappearing. One writer per file at a time — updateMeta's queue, the project's one turn
 * and, within it, the tools' own queue (see tools() in tools.ts) — so a fixed temporary name
 * is enough. It sits in the project's tree, so git has to be told to leave it be (see UNCOMMITTED).
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(`${path}.tmp`, JSON.stringify(value, null, 2), { createPath: false })
  await rename(`${path}.tmp`, path)
}

export async function readMeta(slug: string): Promise<Meta> {
  const stored = await readJson<Partial<Meta>>(join(projectDir(slug), META), {})
  // Every field by name: the turn's closing updateMeta writes back what this returns, so a
  // key missing here is erased from project.json at the end of the next turn.
  return {
    model: stored.model,
    lookModel: stored.lookModel,
    params: storedParams(slug, stored.params),
    gate: isGate(stored.gate) ? stored.gate : undefined,
    design: stored.design === true || undefined,
    budget: isBudget(stored.budget) ? stored.budget : undefined,
    usd: stored.usd ?? 0,
    turns: stored.turns ?? 0,
    // Only known names, each once: the list becomes containers (pod.ts).
    services: Array.isArray(stored.services) ? SERVICES.filter((s) => stored.services!.includes(s)) : undefined,
    dataId: typeof stored.dataId === 'string' && /^[0-9a-f]{8}$/.test(stored.dataId) ? stored.dataId : undefined,
  }
}

/**
 * Stored params, checked as well as at the PATCH: project.json can be edited by hand, and what
 * this returns goes into the request body (see params.ts). A key that fails is not sent, and not
 * kept either — the next write stores what this returns — so the log carries what it was.
 * Key by key: a range tightened since a value was saved — repetition_penalty's floor went from 0
 * to 0.01 — costs that knob, not the effort and every other one with it. Anything but an object
 * goes whole: a number has no keys, so it went with no line, and a string's are its characters,
 * a line for each.
 */
function storedParams(slug: string, stored: unknown): Params | undefined {
  if (stored == null) return undefined
  const ignore = (what: string, v: unknown, e: unknown) =>
    console.error(`[meta ${slug}] ignoring ${what} ${JSON.stringify(v)}: ${(e as Error).message}`)
  if (typeof stored !== 'object' || Array.isArray(stored)) {
    try {
      return cleanParams(stored)
    } catch (e) {
      ignore('params', stored, e)
      return {}
    }
  }
  const params: Params = {}
  for (const [k, v] of Object.entries(stored)) {
    try {
      Object.assign(params, cleanParams({ [k]: v }))
    } catch (e) {
      ignore(`params.${k}`, v, e)
    }
  }
  return params
}

/** The fields to set, or a function of the current Meta that returns them. */
type MetaPatch = Partial<Meta> | ((current: Meta) => Partial<Meta>)

/** slug -> the last write queued for it, until the queue drains. */
const metaWrites = new Map<string, Promise<unknown>>()

/**
 * Read-modify-write, one at a time per project. Unqueued, a settings PATCH that read before
 * a turn's closing write and wrote after it put the old `usd` back — the spend tally rolled
 * back — and the settings panel makes those PATCHes frequent. A change computed from the
 * stored value — the tally, a params patch — is passed as a function, so it runs inside the
 * queue on what the write before it left, not on a read another write has since overtaken.
 */
export function updateMeta(slug: string, patch: MetaPatch): Promise<Meta> {
  const next = (metaWrites.get(slug) ?? Promise.resolve()).catch(() => {}).then(() => writeMeta(slug, patch))
  metaWrites.set(slug, next)
  // Rejection handled too: a bare finally() hands a failed write's rejection to a promise
  // nobody awaits, and Bun exits on an unhandled rejection.
  const drop = () => {
    if (metaWrites.get(slug) === next) metaWrites.delete(slug)
  }
  next.then(drop, drop)
  return next
}

async function writeMeta(slug: string, patch: MetaPatch): Promise<Meta> {
  const dir = await requireProject(slug)
  const current = await readMeta(slug)
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  // requireProject is a check, not a hold: a rename or delete can land after it. So nothing
  // below creates `dir` itself — mkdir is not recursive, writeJson makes no parents — and a
  // project that moved away is a 404. Bun.write's parent-creating default wrote into a
  // recreated old directory instead and answered 200: a ghost with no package.json, listed
  // as a project, blocking its name, and impossible to delete from the UI.
  try {
    await mkdir(join(dir, META_DIR)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e
    })
    await writeJson(join(dir, META), next)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, `no project "${slug}"`)
    throw e
  }
  return next
}

/**
 * Every filesystem path derived from a slug goes through here. Slugs arrive from URL
 * params and Host headers; slugify() collapses "../" to "-", so a slug that survives
 * the round trip unchanged cannot traverse.
 */
export function safeSlug(slug: string): string {
  if (!slug || slug !== slugify(slug)) throw new HttpError(400, `invalid slug "${slug}"`)
  return slug
}

export function projectDir(slug: string): string {
  return join(PROJECTS_DIR, safeSlug(slug))
}

export function shotPath(slug: string): string {
  return join(PROJECTS_DIR, SHOTS, `${safeSlug(slug)}.png`)
}

export function framesDir(slug: string): string {
  return join(PROJECTS_DIR, SHOTS, safeSlug(slug))
}

/** Short SHAs as git prints them and nothing else — this one becomes a filename. */
export function safeSha(sha: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new HttpError(400, `invalid snapshot "${sha}"`)
  return sha
}

export function framePath(slug: string, sha: string): string {
  return join(framesDir(slug), `${safeSha(sha)}.png`)
}

export async function requireProject(slug: string): Promise<string> {
  const dir = projectDir(slug)
  if (!(await Bun.file(join(dir, 'package.json')).exists())) {
    throw new HttpError(404, `no project "${slug}"`)
  }
  return dir
}

/**
 * Not the project's source: dependencies, build output, git's store, our own metadata.
 * One definition for the agent's list_files and for the UI's file tree — the two must
 * never disagree about what a project contains.
 */
const SKIP = new Set(['node_modules', '.git', 'dist', META_DIR])

/** Every source file in a project, relative to its root, sorted. */
export async function listFiles(root: string, dir: string = root): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await listFiles(root, full)))
    else out.push(relative(root, full))
  }
  return out.sort()
}

/**
 * A path into a project's *source* — what the agent may write and what the code pane may
 * open. Two refusals, and every caller takes both: SKIP keeps it out of the four
 * directories that are not source, safePath keeps it inside the project.
 *
 * One definition because the untrusted writer must not be the one with fewer guards: the
 * model's tools used to check only containment, so `write_file .apps-builder/project.json`
 * or `delete_file .git/index` executed as written — against the spend tally the restore
 * path protects on purpose, and against the product's only undo.
 */
export function sourcePath(dir: string, p: string): string {
  if (p.split('/').some((seg) => SKIP.has(seg))) {
    throw new HttpError(400, `not a source file: ${p}`)
  }
  return safePath(dir, p)
}

/**
 * Paths from outside are untrusted. The model writes them, and now a URL query string
 * does too. Resolve first, then refuse anything that leaves the project.
 */
function safePath(dir: string, p: string): string {
  const full = resolve(dir, p)
  if (full !== dir && !full.startsWith(dir + sep)) {
    throw new HttpError(400, `path escapes the project: ${p}`)
  }
  return full
}

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message)
  }
}
