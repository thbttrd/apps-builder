import { randomBytes } from 'node:crypto'
import { cp, link, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type Address, INSTANCE, backend } from './backend'
import { holdLine } from './line'
import { POD_YAML, SERVICES, type Service, podSpec } from './pod'
import { type Sync, startSync } from './sync'
import { screenshot } from './shots'
import { slugify } from '../shared/slug'
import { COMMIT, checkpoint, editedAt, headSha, isBuilt, pageReplaced, run } from './git'
import {
  HttpError,
  type Meta,
  PROJECTS_DIR,
  framePath,
  framesDir,
  projectDir,
  readMeta,
  requireProject,
  safeSlug,
  shotPath,
  updateMeta,
} from './project'

const TEMPLATE = join(import.meta.dir, '..', 'template')
/** Set in staging; unset locally, where there is no wildcard DNS to point an iframe at. */
const PREVIEW_DOMAIN = Bun.env.AB_PREVIEW_DOMAIN ?? ''
const START_TIMEOUT_MS = 30_000
/** The preview image carries the template's node_modules (deploy/preview.Dockerfile): a project runs
 *  in it only with the template's lockfile. */
const TEMPLATE_LOCK = join(TEMPLATE, 'bun.lock')
/** Frames are cheap, not free. The commit outlives its picture; see pruneFrames(). */
const KEEP_FRAMES = 40
/** `exited` resolves when the pod's preview container ends (backend.exited); `sync` and `line` feed it
 *  the project's files and carry its /_ab/fetch out. */
type Running = { address: Address; sync: Sync; line: AbortController; startedAt: string; exited: Promise<void> }

/** slug -> the pod serving it. Empty on boot: nothing is auto-respawned, and api.ts clears
 *  the pods a previous run left (stopAll). */
const running = new Map<string, Running>()
/** slug -> the start in flight: a second `kube play --replace` would replace the first's pod. */
const starting = new Map<string, Promise<Project>>()

/** How long a preview nobody uses keeps running (reapIdle): the cluster runs 8 at most. */
export const IDLE_MS = 30 * 60_000
/** slug -> when its preview was last used: started, a request through addressOf(), a socket ending. */
const lastUsed = new Map<string, number>()
/** slug -> its HMR sockets open (dispatch.ts): a tab, or a gallery card, showing it. */
const viewers = new Map<string, number>()

/** An HMR socket on this preview opened (+1) or closed (-1). Its closing counts as use: it may be a reload. */
export function viewing(slug: string, by: 1 | -1): void {
  viewers.set(slug, Math.max(0, (viewers.get(slug) ?? 0) + by))
  lastUsed.set(slug, Date.now())
}

/**
 * Stops every preview nobody uses: no socket open on it, no turn on its project (`busy`, agent.ts's
 * running(), which previews.ts can't import), and nothing through it for `idleMs`. api.ts runs it
 * every minute. A preview stopped under someone is started again by Start or by check_app.
 */
export async function reapIdle(busy: (slug: string) => boolean, idleMs = IDLE_MS): Promise<void> {
  for (const slug of [...running.keys()]) {
    const idle = Date.now() - (lastUsed.get(slug) ?? 0)
    if (busy(slug) || (viewers.get(slug) ?? 0) > 0 || idle < idleMs) continue
    console.log(`[preview ${slug}] unused for ${Math.round(idle / 60_000)} min: stopped`)
    await stopPreview(slug).catch((e) => console.error(`[preview ${slug}] idle stop:`, (e as Error).message))
  }
}

/** A project as the listing shows it: its metadata, and what the disk and the pods say of it. */
export type Project = Meta & {
  slug: string
  running: boolean
  port?: number
  url?: string
  startedAt?: string
  /** When the project was last touched — see editedAt(). Absent only if the stat fails. */
  updatedAt?: string
  /** When the preview was last photographed. Absent until it has run at least once. */
  shotAt?: string
  /** Whether the first build has landed. Until then the only app on disk is the template's,
   *  and nothing shows it: the workspace is the chat alone, History is empty. See isBuilt().
   *  True mid-turn too, once that turn has replaced the template's page (pageReplaced) and the
   *  running preview serves what "/" now shows (pageServes), so the preview slides in while the
   *  rest of the build lands in it — on the app, never on vite's error overlay, and only with a
   *  preview to show. */
  built: boolean
}

function urlFor(slug: string, address: Address): string {
  return PREVIEW_DOMAIN ? `https://${slug}.${PREVIEW_DOMAIN}/` : `${address.vite}/`
}

/** The running preview's address. Every caller is a use of it (the dispatcher's requests, check_app): reapIdle. */
export function addressOf(slug: string): Address | undefined {
  const live = running.get(slug)
  if (live) lastUsed.set(slug, Date.now())
  return live?.address
}

/**
 * Until the pod holds every file the disk has now: the pod's /app is a copy, pushed as files change
 * (sync.ts), and whatever reads the preview must not read it behind the disk. Never throws: a preview
 * that can't take the push is said in the log, and is read as it is.
 */
export async function flushPreview(slug: string): Promise<void> {
  await running.get(slug)?.sync.flush().catch((e) => console.error(`[preview ${slug}] flush:`, (e as Error).message))
}

/** One capture per project at a time: two would race on the one output path. */
const shooting = new Set<string>()

/**
 * A preview can only be photographed while it runs, so a turn on a stopped project leaves
 * the old picture on its card. Starting it again is the moment to catch up.
 */
async function shotIsStale(slug: string): Promise<boolean> {
  const shot = await stat(shotPath(slug)).catch(() => null)
  if (!shot) return true
  const edited = await editedAt(projectDir(slug))
  return edited !== undefined && Date.parse(edited) > shot.mtime.getTime()
}

/**
 * Photograph this preview, for the gallery to show once it is stopped. Fire-and-forget:
 * never throws, and nothing waits for it — a missing thumbnail is worth less than the
 * turn that would have failed producing it.
 */
export async function recordShot(slug: string): Promise<void> {
  const live = running.get(slug)
  if (!live || shooting.has(slug)) return
  shooting.add(slug)
  try {
    await mkdir(framesDir(slug), { recursive: true })
    // 127.0.0.1, not the preview hostname: that one goes through Traefik's forwardAuth,
    // and this process has no cookie to show it.
    // HEAD is read before the shutter, not after. vite serves what is on disk, and what
    // is on disk is the commit that was HEAD when this was called — recordShot runs right
    // after a checkpoint. Reading it afterwards files the picture under whatever landed
    // while the camera was warming up: measured, a hand edit mid-capture put the
    // scaffold's picture under the edit's sha and left the scaffold with none.
    const sha = await headSha(projectDir(slug))
    await flushPreview(slug)

    const card = shotPath(slug)
    if (!(await screenshot(`${live.address.vite}/`, card)) || !sha) return

    // The card and the frame are two names for one file. A copy would work too — it is
    // 10-400 KB — but two names cannot disagree, and pruning a frame leaves the card
    // pointing at the same bytes.
    const frame = framePath(slug, sha)
    await rm(frame, { force: true })
    await link(card, frame)
    await pruneFrames(slug)
  } catch (e) {
    console.error(`[shot ${slug}]`, e)
  } finally {
    shooting.delete(slug)
  }
}

/**
 * Keep the newest KEEP_FRAMES pictures. The commit survives its picture: an old snapshot
 * stays restorable, its frame just goes blank — which is the right way round, because the
 * timeline is the commits and the pictures are decoration on it.
 */
async function pruneFrames(slug: string): Promise<void> {
  const dir = framesDir(slug)
  const files = await readdir(dir).catch(() => [])
  if (files.length <= KEEP_FRAMES) return
  const dated = await Promise.all(
    files.map(async (f) => ({ f, at: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  )
  dated.sort((a, b) => b.at - a.at)
  await Promise.all(dated.slice(KEEP_FRAMES).map((d) => rm(join(dir, d.f), { force: true })))
}

export async function listProjects(): Promise<Project[]> {
  // Disk is the source of truth — a project outlives the process that previews it.
  const entries = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => [])
  const projects = await Promise.all(
    entries
      // The same predicate safeSlug() applies, so every downstream call on these names
      // is unreachable by construction. Subsumes the old dot-prefix rule — `.shots`
      // is not its own slugify — and stops one hand-made `My Project/` rejecting the
      // whole Promise.all and 400ing the gallery, /api/health included.
      .filter((e) => e.isDirectory() && e.name === slugify(e.name))
      .map((e) => projectOf(e.name)),
  )
  return projects.sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * One project as the listing shows it, without listing the others. A slug that is no project —
 * one deleted meanwhile — reads as an empty one: not running, built, nothing spent.
 */
export async function projectOf(slug: string): Promise<Project> {
  const dir = projectDir(slug)
  const live = running.get(slug)
  return {
    slug,
    running: live !== undefined,
    built: (await isBuilt(dir)) || (live !== undefined && (await pageReplaced(dir)) && (await flushPreview(slug), await pageServes(live.address.vite, dir))),
    updatedAt: await editedAt(dir),
    shotAt: await stat(shotPath(slug))
      .then((s) => s.mtime.toISOString())
      .catch(() => undefined),
    ...(live && { port: Number(new URL(live.address.vite).port), url: urlFor(slug, live.address), startedAt: live.startedAt }),
    ...(await readMeta(slug)),
  }
}

/**
 * Whether the running preview serves what "/" shows, as modules: main.tsx, every import of which
 * has to resolve — so the page "/" now routes to is on disk, and a Home.tsx deleted while main.tsx
 * still imports it is not — and Home.tsx too, while it is there. vite answers 500 for a module
 * naming an import that does not resolve — the page written before the parts it imports — and,
 * for one that is gone, its SPA fallback's index.html with a 200. Either would slide in as the app.
 *
 * A query of its own each time, so vite reads the file afresh: the plain URL is served from its
 * last transform until vite's watcher hears of the write, 5 to 50 ms after it, and a listing
 * asked for straight after the write was answered from the template. Each probe leaves vite one
 * module behind, a few per first build, gone with the pod. Measured on vite 8, 2026-10-09.
 * Never throws: unanswered is not served.
 */
async function pageServes(vite: string, dir: string): Promise<boolean> {
  const serves = async (path: string) => {
    const r = await fetch(`${vite}/${path}?ab-probe=${crypto.randomUUID()}`, { signal: AbortSignal.timeout(3000) }).catch(() => null)
    r?.body?.cancel().catch(() => {})
    return r?.ok === true && (r.headers.get('content-type') ?? '').includes('javascript')
  }
  const home = await Bun.file(join(dir, 'src/Home.tsx')).exists()
  return (await serves('src/main.tsx')) && (!home || (await serves('src/Home.tsx')))
}

export async function createProject(name: string): Promise<Project> {
  const slug = slugify(name)
  if (!slug) throw new HttpError(400, 'name must contain at least one letter or digit')

  const dir = projectDir(slug)
  await mkdir(PROJECTS_DIR, { recursive: true })
  // mkdir without recursive is the lock: it fails if the slug is taken, with no
  // read-then-write window for a second request to slip through.
  await mkdir(dir).catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'EEXIST' ? new HttpError(409, `project "${slug}" already exists`) : e
  })

  try {
    await cp(TEMPLATE, dir, {
      recursive: true,
      filter: (src) => !src.includes('/node_modules') && !src.includes('/dist'),
    })
    await run([process.execPath, 'install', '--frozen-lockfile'], dir)
    await run(['git', 'init', '-q'], dir)
    // A baseline to revert to. The note here used to say no initial commit was needed,
    // because the diff pane reads `git add -A && git diff --cached` and shows untracked
    // files anyway — true, and it left every project with zero commits and therefore no
    // undo at all. Superseded: turn N's commit is now exactly what turn N changed.
    await checkpoint(dir, COMMIT.scaffold)
  } catch (e) {
    await rm(dir, { recursive: true, force: true })
    throw e
  }

  return startPreview(slug)
}

/**
 * `shoot`: whether a stale picture may be retaken now. Not from check_app, which starts it
 * mid-turn: the disk then holds the turn's unfinished writes, and recordShot would file them
 * under the last commit. The turn's own recordShot, at its end, takes the right one.
 */
export function startPreview(slug: string, shoot = true): Promise<Project> {
  if (running.has(slug)) return projectOf(slug)
  let start = starting.get(slug)
  if (!start) {
    start = launch(slug, shoot).finally(() => starting.delete(slug))
    starting.set(slug, start)
  }
  return start
}

const podName = (slug: string) => `ab-${INSTANCE}-${slug}`

async function launch(slug: string, shoot: boolean): Promise<Project> {
  const dir = await requireProject(slug)
  await sameLock(dir)
  const name = podName(slug)
  const startedAt = new Date().toISOString()
  const meta = await readMeta(slug)
  const services = meta.services ?? []
  // The control port's, per start, in the preview container's environment alone (pod.ts).
  const token = randomBytes(24).toString('hex')
  const data = await backend.dataVolume(slug, await dataIdOf(slug, meta), services)
  const spec = podSpec(name, { 'apps-builder/instance': INSTANCE, 'apps-builder/app': slug, 'apps-builder/owner': 'default' }, services, token, data)
  // Kept beside the project as a record of what runs (never committed, never pushed): without the
  // token, which the model's read_file could otherwise hand to the app's server.
  await mkdir(dirname(join(dir, POD_YAML)), { recursive: true })
  await writeFile(
    join(dir, POD_YAML),
    `# The app's preview, as a Kubernetes Pod. Written by apps-builder at every start.\n${Bun.YAML.stringify(spec, null, 2).replaceAll(token, '<per-start token>')}`,
  )
  const line = new AbortController()
  let sync: Sync | undefined
  let exited: Promise<void> | undefined
  try {
    const address = await backend.run(spec)
    exited = backend.exited(name)
    await answers(address.control, exited)
    sync = await startSync(dir, address.control, token)
    holdLine(address.control, token, line.signal)
    await answers(address.vite, exited)
    running.set(slug, { address, sync, line, startedAt, exited })
    lastUsed.set(slug, Date.now())
  } catch (e) {
    sync?.stop()
    line.abort()
    const tail = await backend.logs(name, 'preview')
    await backend.remove(name).catch((r) => console.error(`[preview ${slug}]`, (r as Error).message))
    // A refusal meant for the person (the cluster's quota) reaches them as it is.
    if (e instanceof HttpError) throw e
    throw new Error(`${(e as Error).message}${tail ? `\n${tail}` : ''}`)
  }
  const live = running.get(slug)
  // Starting is the other moment a picture can be taken, and the only one for a
  // project that has never had one. Not on every start — that would overwrite a turn's
  // picture with the same app — but a stale one is worth replacing.
  if (shoot && (await shotIsStale(slug))) void recordShot(slug)
  void exited.then(() => {
    // Only clear if this is still the registered pod — a restart may have replaced it.
    if (running.get(slug) === live) {
      running.delete(slug)
      sync?.stop()
      line.abort()
    }
  })
  return projectOf(slug)
}

/**
 * The name of the app's database volume on the cluster (kube.ts: data-<dataId>), made at the first start
 * that needs one — after its first add_service of a database, or for an app that had one before — and kept
 * in project.json: a slug can be renamed, a volume can't. '' when the app has no database.
 */
async function dataIdOf(slug: string, meta: Meta): Promise<string> {
  if (!meta.services?.some((s) => s === 'redis' || s === 'postgres')) return ''
  if (meta.dataId) return meta.dataId
  const dataId = randomBytes(4).toString('hex')
  await updateMeta(slug, () => ({ dataId }))
  return dataId
}

/** A project whose lockfile is not the template's would run against packages it did not pin. */
async function sameLock(dir: string): Promise<void> {
  const hash = async (file: string) => new Bun.CryptoHasher('sha256').update(await Bun.file(file).arrayBuffer()).digest('hex')
  const ours = await hash(join(dir, 'bun.lock')).catch(() => 'missing')
  if (ours !== (await hash(TEMPLATE_LOCK))) {
    throw new HttpError(409, "this project's bun.lock is not the template's: the preview image carries the template's node_modules, so it can't run this app")
  }
}

/** Until `url` answers — any status — or the pod's container ends, or START_TIMEOUT_MS. */
async function answers(url: string, exited: Promise<void>): Promise<void> {
  let dead = false
  void exited.then(() => (dead = true))
  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    if (dead) throw new Error('the preview exited before serving')
    if (Date.now() > deadline) throw new Error(`the preview did not answer within ${START_TIMEOUT_MS / 1000}s`)
    const up = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    )
    if (up) return
    await Bun.sleep(100)
  }
}

export async function stopPreview(slug: string): Promise<void> {
  // A start under way finishes first: otherwise it registers a pod, mounting this directory,
  // after the caller has moved or removed it.
  await starting.get(slug)?.catch(() => {})
  const live = running.get(slug)
  // delete first: the exit handler checks identity, so this cannot race a restart
  running.delete(slug)
  // The push first: both callers then move or remove the directory it reads.
  live?.sync.stop()
  live?.line.abort()
  // Awaited, and removed when nothing is registered too: a preview whose container died is gone
  // from `running`, but the rest of its pod is not — a server, and a Postgres that a rename would
  // start a second time on the same data.
  await backend.remove(podName(slug))
}

/**
 * Add `service` to the app — with the server, if it is a database — and restart a running
 * preview, so its pod is played again with the containers. Answers what was new.
 */
export async function addService(slug: string, service: Service): Promise<Service[]> {
  await requireProject(slug)
  const wanted: Service[] = service === 'server' ? ['server'] : ['server', service]
  const had = (await readMeta(slug)).services ?? []
  const added = wanted.filter((s) => !had.includes(s))
  if (!added.length) return []
  await updateMeta(slug, (m) => ({ services: SERVICES.filter((s) => wanted.includes(s) || m.services?.includes(s)) }))
  await starting.get(slug)?.catch(() => {})
  if (running.has(slug)) {
    await stopPreview(slug)
    await startPreview(slug, false)
  }
  return added
}

/** The server's last log lines, or null when the app has no server. For check_app's report. */
export async function serverLog(slug: string): Promise<string | null> {
  if (!(await readMeta(slug)).services?.includes('server')) return null
  return backend.logs(podName(slug), 'server')
}

export async function renameProject(slug: string, name: string): Promise<Project> {
  const from = await requireProject(slug)
  const to = slugify(name)
  if (!to) throw new HttpError(400, 'name must contain at least one letter or digit')
  if (to === slug) return projectOf(slug)

  const target = projectDir(to)
  if (await Bun.file(join(target, 'package.json')).exists()) {
    throw new HttpError(409, `project "${to}" already exists`)
  }

  // vite's cwd is this directory; moving it out from under a running process leaves it
  // serving a path that no longer exists. Stop, move, and bring it back under the new slug.
  const wasRunning = addressOf(slug) !== undefined
  await stopPreview(slug)
  await rename(from, target)
  // The pictures follow the project. Losing them would be harmless — the next turn takes
  // another — but only if the project is ever started again.
  await rename(shotPath(slug), shotPath(to)).catch(() => {})
  await rename(framesDir(slug), framesDir(to)).catch(() => {})
  // The databases too, and those are not harmless to lose.
  await backend.renameData(slug, to)
  return wasRunning ? startPreview(to) : projectOf(to)
}

/**
 * createProject under `name`, or under its slug with -2, -3 … up to -9 when that is taken.
 * For a name the server made up from a prompt: two apps described alike get the same name,
 * and the second must not fail for it. A name the person typed goes to createProject, whose
 * 409 is the answer they need.
 */
export async function createUnique(name: string): Promise<Project> {
  const slug = slugify(name)
  if (!slug) throw new HttpError(400, 'name must contain at least one letter or digit')
  // Room for the suffix inside slugify's 40, and no separator left at the cut, so each
  // candidate is its own slugify (see slug.ts).
  const base = slug.slice(0, 37).replace(/-+$/, '')
  for (let n = 1; n <= 9; n++) {
    try {
      return await createProject(n === 1 ? slug : `${base}-${n}`)
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 409)) throw e
    }
  }
  throw new HttpError(409, `project "${slug}" and "${base}-2" to "${base}-9" already exist`)
}

export async function deleteProject(slug: string): Promise<void> {
  const dir = await requireProject(slug)
  const { dataId } = await readMeta(slug)
  await stopPreview(slug)
  // The databases first: if their volume can't go, the project stays to be deleted again, rather
  // than a volume nothing points at holding a deleted app's data against the quota.
  await backend.removeData(safeSlug(slug), dataId ?? '')
  await rm(dir, { recursive: true, force: true })
  await rm(shotPath(slug), { force: true })
  await rm(framesDir(slug), { recursive: true, force: true })
}

/** Every pod this instance runs, the ones a killed predecessor left included. */
export async function stopAll(): Promise<void> {
  for (const live of running.values()) {
    live.sync.stop()
    live.line.abort()
  }
  running.clear()
  await backend.removeAll()
}
