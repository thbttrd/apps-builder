/** :8787, the apps-builder UI and its API: `app`, which api.ts serves. */
import { join, relative } from 'node:path'
import { type Context, Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { setCookie } from 'hono/cookie'
import type { ModelMessage } from 'ai'
import { abortTurn, artefacts, chat, claimed, history, running } from './agent'
import { DEFAULT_LOOK_MODEL, DEFAULT_MODEL, configured, nameFor } from './model'
import { SERVICES, type Service } from './pod'
import { COMMIT, type RestoreMode, checkpoint, isBuilt, listSnapshots, restoreSnapshot } from './git'
import {
  type Project,
  addService,
  createProject,
  createUnique,
  deleteProject,
  listProjects,
  projectOf,
  recordShot,
  renameProject,
  startPreview,
  stopPreview,
} from './previews'
import {
  HttpError,
  TURN,
  diffPath,
  framePath,
  listFiles,
  readMeta,
  requireProject,
  shotPath,
  sourcePath,
  turnBefores,
  updateMeta,
  writeJson,
} from './project'
import { type Settings, settingsPatch } from '../shared/settings'
import {
  DESIGNS_DIR,
  DOC_FILE,
  type Design,
  type DesignPhase,
  IDS,
  SHOTS,
  appName,
  approve,
  designPhase,
  designView,
  pick,
  readDesign,
  unpick,
} from './design'
import { CSP } from './design-check'
import { GIT_SHA, STARTED_AT, versionInfo } from './version'


import { PREVIEW_SECRET } from './dispatch'
const COOKIE_DOMAIN = Bun.env.COOKIE_DOMAIN ?? ''

/** A request's JSON body, or null when it has none or it does not parse: each route checks its own shape. */
const bodyOf = async <T>(c: Context) => (await c.req.json().catch(() => null)) as Partial<T> | null

/** A file from disk as the answer, with these headers, or a 404 saying `missing` when there is none. */
async function served(path: string | null, missing: string, headers: Record<string, string> = {}): Promise<Response> {
  const file = path ? Bun.file(path) : null
  if (!file || !(await file.exists())) throw new HttpError(404, missing)
  return new Response(file, { headers })
}

export const app = new Hono()

app.onError((err, c) =>
  err instanceof HttpError
    ? c.json({ error: err.message }, err.status)
    : (console.error(`[api ${c.req.method} ${c.req.path}]`, err), c.json({ error: String(err) }, 500)),
)

// A write only from the UI's own pages. A preview is same-site with the UI (`*.example.net`), so the
// browser sends the person's SSO cookie with a request an app's page makes here, and the proxy stamps the
// origin header on it as on any other: a text/plain POST needs no preflight, and bodyOf() reads it.
// Browsers always say where a request comes from; scripts and curl send nothing, and pass.
// ponytail: Sec-Fetch-Site only; add an Origin-vs-Host check if a browser older than 2023 matters.
app.use('/api/*', async (c, next) => {
  const site = c.req.header('sec-fetch-site')
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && site && site !== 'same-origin') {
    return c.json({ error: 'refused: a write from another site' }, 403)
  }
  await next()
})

app.get('/api/health', async (c) =>
  c.json({ ok: true, sha: GIT_SHA, startedAt: STARTED_AT, previews: (await listProjects()).filter((p) => p.running).length }),
)

/**
 * What is running here: the declared version, the commit, and CHANGELOG.md parsed into
 * entries — the About screen's whole payload. Asked for rather than compiled into the
 * bundle, because a dist built from one commit and served from the tree of another would
 * otherwise announce the wrong one with total confidence.
 */
app.get('/api/version', async (c) => c.json(await versionInfo()))

// Handing out the preview cookie is the whole authorisation step: this origin sits
// behind the SSO proxy, and gate() has already checked the header the SSO proxy stamps after
// it, so getting here is the proof. The cookie is scoped to the parent domain so the
// cross-site preview iframe sends it, and SameSite=None is mandatory for exactly that
// reason — a Lax cookie is dropped in a cross-site frame.
app.post('/api/session', (c) => {
  if (!PREVIEW_SECRET) return c.json({ error: 'AB_PREVIEW_SECRET is not set' }, 503)
  setCookie(c, 'ab_preview', PREVIEW_SECRET, {
    domain: COOKIE_DOMAIN || undefined,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    maxAge: 60 * 60 * 12,
  })
  return c.json({ ok: true })
})

app.get('/api/projects', async (c) => c.json(await listProjects()))

// A name the person typed is the project's name, as it always was. Without one, the start
// page sends the prompt it is about to open the chat with, and the project is named from it.
// The prompt itself is not sent here as a turn: the client sends it to /chat like any other
// message, so the turn streams to the page that asked for it.
//
// `settings` are the start page's More: the project is made with them, so its first turn
// already runs on the model and the gate chosen there.
app.post('/api/projects', async (c) => {
  const body = await bodyOf<{ name: unknown; prompt: unknown; settings: unknown }>(c)
  const { name, prompt } = body ?? {}
  // Checked before anything is made, the naming call included: a setting a PATCH would refuse
  // refuses the create, and leaves no directory behind.
  const change = settingsOf(body?.settings)
  if (typeof name === 'string' && (name.trim() || typeof prompt !== 'string')) {
    return c.json(await madeWith(await createProject(name), change), 201)
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new HttpError(400, 'body must be {"name": string} or {"prompt": string}')
  }
  const named = await nameFor(prompt.trim())
  // The naming call was spent on this project, so its tally carries it.
  return c.json(await madeWith(await createUnique(named.name), change, named.usd), 201)
})

/** A settings change from a request, checked; a refusal is the client's 400. */
function settingsOf(body: unknown): ((current: Settings) => Settings) | null {
  try {
    return settingsPatch(body)
  } catch (e) {
    throw new HttpError(400, (e as Error).message)
  }
}

/** A project just made, with the settings it was made with and what naming it cost. */
async function madeWith(p: Project, change: ((s: Settings) => Settings) | null, usd = 0): Promise<Project> {
  if (!change && !usd) return p
  return { ...p, ...(await updateMeta(p.slug, (m) => ({ ...change?.(m), usd: m.usd + usd }))) }
}

/** What a project with no settings of its own runs on, and whether it can run at all. */
const house = () => ({ configured: configured(), defaultModel: DEFAULT_MODEL, defaultLookModel: DEFAULT_LOOK_MODEL })
/** GET /house. */
export type House = ReturnType<typeof house>
/** GET /chat: the house, whether a turn runs, and the stored history (chat.json). */
export type ChatGet = House & { running: boolean; messages: ModelMessage[] }

// The chat's GET says it too; this is for the start page, whose More has no project to ask yet.
app.get('/api/house', (c) => c.json(house()))

// No picture while a turn runs: the disk holds its unfinished writes (see startPreview).
app.post('/api/projects/:slug/start', async (c) => c.json(await startPreview(c.req.param('slug'), !running(c.req.param('slug')))))

// The quota's 503 asks the person to stop a preview: this is how. Not mid-turn, whose check_app would
// start it again at once.
app.post('/api/projects/:slug/stop', async (c) => {
  const slug = c.req.param('slug')
  await requireProject(slug)
  if (running(slug)) throw new HttpError(409, 'a turn is running on this project: stop it first')
  await stopPreview(slug)
  return c.json(await projectOf(slug))
})

// What add_service does, for the check suite and for a person with curl: the same function.
app.post('/api/projects/:slug/services', async (c) => {
  const service = (await bodyOf<{ service: unknown }>(c))?.service
  if (!SERVICES.includes(service as Service)) throw new HttpError(400, `service must be one of ${SERVICES.join(', ')}`)
  return c.json({ added: await addService(c.req.param('slug'), service as Service) })
})

/**
 * What the preview looked like: the newest picture with no `sha`, which is the gallery's
 * card, or one snapshot's frame with it.
 *
 * A frame is the picture of one commit and can never change, so it is immutable forever.
 * The card is whatever is newest, and the listing's `shotAt` is what busts it.
 */
app.get('/api/projects/:slug/screenshot', async (c) => {
  const slug = c.req.param('slug')
  await requireProject(slug)
  const sha = c.req.query('sha')
  return served(sha ? framePath(slug, sha) : shotPath(slug), `no screenshot for "${slug}"`, {
    'cache-control': sha ? 'private, max-age=31536000, immutable' : 'private, max-age=300',
  })
})

// ── snapshots ─────────────────────────────────────────────────────────────
// The timeline is `git log`. Restoring writes one more commit onto it, so going back is
// itself something you can go back from.

app.get('/api/projects/:slug/history', async (c) =>
  c.json(await listSnapshots(c.req.param('slug'))),
)

app.post('/api/projects/:slug/restore', async (c) => {
  const slug = c.req.param('slug')
  const body = await bodyOf<{ sha: unknown; mode: unknown }>(c)
  const sha = body?.sha
  // The default is the whole state — code and the conversation that produced it. Code-only
  // is the one that leaves the model believing something untrue, so it has to be asked for.
  const mode = body?.mode ?? 'code+chat'
  if (typeof sha !== 'string' || (mode !== 'code' && mode !== 'code+chat')) {
    throw new HttpError(400, 'body must be {"sha": string, "mode"?: "code" | "code+chat"}')
  }

  // Under the turn's claim, like the hand edit, for the same reason and more of it: this
  // rewrites every file in the project, and a turn would be in the middle of writing some.
  return claimed(slug, `a turn is running for "${slug}"`, async () => {
    // The app on disk is not the app that was photographed a moment ago.
    if (await restoreSnapshot(slug, sha, mode as RestoreMode)) void recordShot(slug)
    return c.json(await projectOf(slug))
  })
})

// One endpoint for both because they are one thing: the project's settings. Rename
// moves the directory, so the slug — and with it the preview hostname — really changes.
app.patch('/api/projects/:slug', async (c) => {
  const slug = c.req.param('slug')
  await requireProject(slug) // 404 rather than a 200 describing a project that is not there
  const body = await bodyOf<{ name: unknown }>(c)
  // Settings apply from the next turn, which reads them at its start, so unlike a rename
  // they need no running-turn guard. One write, so a model switch and the params it clears
  // cannot land half-way. The body's other keys are settings, checked as a create's are.
  const change = settingsOf(body)
  // Refused together: the settings would be written before a rename that can still fail,
  // and to the slug it is about to change. No client sends both.
  if (change && typeof body?.name === 'string') {
    throw new HttpError(400, 'a rename and a settings change are separate requests')
  }
  if (change) await updateMeta(slug, change)
  if (typeof body?.name === 'string') {
    // The same claim restore and PUT /file take, for a sharper reason: the agent pins
    // `dir` once at the top of a turn and every write_file resolves against it, so a
    // rename mid-turn sends the rest of the turn's files into a recreated ghost of the
    // old directory — and then kills the turn, before chat.json and the checkpoint.
    const name = body.name
    return claimed(slug, `a turn is running for "${slug}"`, async () => c.json(await renameProject(slug, name)))
  }
  return c.json(await projectOf(slug))
})

app.post('/api/projects/:slug/chat/stop', async (c) =>
  c.json({ stopped: await abortTurn(c.req.param('slug')) }),
)

app.delete('/api/projects/:slug', async (c) => {
  const slug = c.req.param('slug')
  // Await the turn, do not merely signal it: the loop may be inside a write_file, and
  // Bun.write creates parent directories, so a straggling write would recreate the
  // project we are deleting. Composed here rather than inside deleteProject to keep
  // previews.ts and agent.ts from importing each other.
  await abortTurn(slug)
  await deleteProject(slug)
  return c.body(null, 204)
})

app.get('/api/projects/:slug/chat', async (c) =>
  c.json({
    ...house(),
    running: running(c.req.param('slug')),
    messages: await history(c.req.param('slug')),
  } satisfies ChatGet),
)

app.get('/api/projects/:slug/artefacts', async (c) => c.json(await artefacts(c.req.param('slug'))))

// ── the design examples (design.ts) ───────────────────────────────────────
// Pages the model wrote, served on this origin — the app's own, whose cookie reaches /api. So
// each is sandboxed by its CSP, as the relay's pages are (fetch-relay.mjs): an opaque origin,
// no scripts, no forms, and nothing loaded but Google Fonts. The picker's iframe is sandboxed
// too; the header is what holds when the page is opened on its own.

/** An example's id from the path, or a 404: only A, B and C are files. */
const exampleId = (id: string) => {
  if (!(IDS as readonly string[]).includes(id)) throw new HttpError(404, `no design example "${id}"`)
  return id
}

app.get('/api/projects/:slug/designs/:id', async (c) => {
  const dir = await requireProject(c.req.param('slug'))
  return served(join(dir, DESIGNS_DIR, `${exampleId(c.req.param('id'))}.html`), 'that example has not passed its check', {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    // A revision replaces it at the same path.
    'cache-control': 'no-store',
  })
})

/** Its pictures, as the check took them: desktop, phone, and their dark ones. `?v=` busts a revision. */
app.get('/api/projects/:slug/designs/:id/:shot', async (c) => {
  const dir = await requireProject(c.req.param('slug'))
  const shot = c.req.param('shot').replace(/\.jpg$/, '')
  if (!(SHOTS as readonly string[]).includes(shot)) throw new HttpError(404, `no picture "${shot}"`)
  return served(join(dir, DESIGNS_DIR, `${exampleId(c.req.param('id'))}-${shot}.jpg`), 'no such picture', {
    'content-type': 'image/jpeg',
    'cache-control': c.req.query('v') ? 'private, max-age=31536000, immutable' : 'no-store',
  })
})

/**
 * A change to the design phase, under the turn's claim: `act` is given design.json and the phase it
 * is in, and the answer is the view of where it leaves the phase.
 */
async function designAct(
  c: Context,
  slug: string,
  busy: string,
  act: (dir: string, phase: DesignPhase, stored: Design | null) => Promise<Design>,
) {
  const dir = await requireProject(slug)
  return claimed(slug, busy, async () => {
    const [meta, built, stored] = await Promise.all([readMeta(slug), isBuilt(dir), readDesign(dir)])
    const design = await act(dir, designPhase(meta.design === true, built, stored), stored)
    return c.json(designView(designPhase(meta.design === true, await isBuilt(dir), design), design))
  })
}

/**
 * The person's pick: an example that passed, or null when none did. Code records it, and the
 * picker then sends a message that starts the next turn, whose note hands the model the picked
 * design (takeMessage). Refused while a turn runs, like every other write to a project.
 */
app.post('/api/projects/:slug/designs/pick', async (c) => {
  const body = await bodyOf<{ id: unknown }>(c)
  if (!body || !('id' in body)) throw new HttpError(400, 'body must be {"id": "A" | "B" | "C" | null}')
  return designAct(c, c.req.param('slug'), 'a turn is running: pick once it has finished', (dir, phase, stored) => pick(dir, phase, stored, body.id))
})

/**
 * The approval of DESIGN.md: code writes the design into the app and commits it (design.ts,
 * approve), and the card then sends a message that starts the planning turn, whose note says
 * what was applied. Refused while a turn runs, and outside 'approve'.
 */
app.post('/api/projects/:slug/designs/approve', (c) =>
  designAct(c, c.req.param('slug'), 'a turn is running: approve once it has finished', (dir, phase, stored) => approve(dir, phase, stored, appName(c.req.param('slug')))),
)

/** Back to the examples: the pick and its DESIGN.md undone. Refused while a turn runs, and outside 'draft' and 'approve'. */
app.post('/api/projects/:slug/designs/unpick', (c) =>
  designAct(c, c.req.param('slug'), 'a turn is running: go back once it has finished', unpick),
)

/** DESIGN.md as the file, for Artefacts' "Open DESIGN.md": text, never rendered. */
app.get('/api/projects/:slug/design.md', async (c) =>
  served(join(await requireProject(c.req.param('slug')), DOC_FILE), 'no DESIGN.md yet', {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  }),
)

app.post('/api/projects/:slug/chat', async (c) => {
  const body = await bodyOf<{ message: unknown; ask?: unknown }>(c)
  const message = body?.message
  if (typeof message !== 'string' || !message.trim() || (body?.ask !== undefined && typeof body.ask !== 'string')) {
    throw new HttpError(400, 'body must be {"message": string, "ask"?: string}')
  }
  return new Response(await chat(c.req.param('slug'), message, body?.ask as string | undefined), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      // the agent loop outlives any proxy buffer that tries to be helpful
      'x-accel-buffering': 'no',
    },
  })
})

// ── the code pane ─────────────────────────────────────────────────────────
// Reads work on a stopped project — files outlive the vite process serving them. The
// write is guarded three ways: refused while a turn is running, refused unless the caller
// echoes the token it read, and checkpointed so it can be reverted like any turn.

/** Big enough for any source file the agent writes, small enough that a stray PNG in
 *  public/ cannot be shipped down as a JSON string. */
const MAX_VIEW_BYTES = 512 * 1024

/**
 * A cheap content token for optimistic concurrency. Not a security hash — it only has to
 * change when the bytes change, so wyhash is the right tool and sha256 would be theatre.
 */
const tokenOf = (bytes: Uint8Array) => Bun.hash(bytes).toString(16)

/** GET /files: every source file, as the tree lists them. */
export type Tree = { files: string[] }
/**
 * GET /file: a text file whole, with the token a save hands back (PUT /file refuses a stale one
 * with a 409) and, when the newest turn changed it, what it was before; a binary or too-big
 * file, only that it is one.
 */
export type FileBody = { path: string; size: number; binary?: true; content?: string; token?: string; was?: string }
/** PUT /file: the file as written, and the token the next save needs. */
export type Written = { path: string; size: number; token: string }

app.get('/api/projects/:slug/files', async (c) =>
  c.json({ files: await listFiles(await requireProject(c.req.param('slug'))) } satisfies Tree),
)

app.get('/api/projects/:slug/file', async (c) => {
  const dir = await requireProject(c.req.param('slug'))
  const path = c.req.query('path')
  if (!path) throw new HttpError(400, 'path is required')
  // sourcePath refuses traversal and the four non-source directories together. What the
  // API serves and what the tree lists must be the same set, or the pane can open what
  // it cannot show — and the agent's tools now refuse exactly the same set.
  const file = Bun.file(sourcePath(dir, path))
  if (!(await file.exists())) throw new HttpError(404, `no such file: ${path}`)
  if (file.size > MAX_VIEW_BYTES) return c.json({ path, size: file.size, binary: true } satisfies FileBody)

  const bytes = new Uint8Array(await file.arrayBuffer())
  // A NUL byte in the first 8KB is git's own binary test, and it is the cheap one.
  // Decoding a PNG as UTF-8 would fill the pane with replacement characters instead
  // of saying plainly that this is not text.
  if (bytes.subarray(0, 8192).includes(0)) return c.json({ path, size: file.size, binary: true } satisfies FileBody)
  const content = new TextDecoder().decode(bytes)
  // What the newest turn found here before it changed the file, for the pane to colour the change.
  const was = (await turnBefores(dir))[relative(dir, sourcePath(dir, path))]
  return c.json({
    path,
    size: file.size,
    token: tokenOf(bytes),
    content,
    ...(typeof was === 'string' && was !== content && { was }),
  } satisfies FileBody)
})

/** What one write_file or edit_file call changed (shared/diff.ts), for its row in the chat. */
app.get('/api/projects/:slug/diffs/:id', async (c) => {
  const dir = await requireProject(c.req.param('slug'))
  return served(diffPath(dir, c.req.param('id')), 'no diff kept: it changed nothing, or it ran before diffs were kept', {
    'content-type': 'application/json',
  })
})

app.put('/api/projects/:slug/file', async (c) => {
  const slug = c.req.param('slug')
  const dir = await requireProject(slug)
  const body = await bodyOf<{ path: unknown; content: unknown; token: unknown }>(c)
  const path = body?.path
  const content = body?.content
  if (typeof path !== 'string' || typeof content !== 'string') {
    throw new HttpError(400, 'body must be {"path": string, "content": string, "token": string}')
  }

  // Guard 1: never write into a project the agent is writing into. Two writers on one
  // file is not a merge problem, it is a lost-work problem.
  return claimed(slug, `a turn is running for "${slug}"`, async () => {
    // Editing only, never creating: the tree is the only way to pick a file, so a path that
    // does not exist means the caller is out of date, not that it wants a new file.
    const target = sourcePath(dir, path)
    const file = Bun.file(target)
    if (!(await file.exists())) throw new HttpError(404, `no such file: ${path}`)

    // Guard 2: the token from the GET this edit started from. Without it, an agent turn that
    // rewrote the file while it sat open in the editor is silently destroyed on save.
    const current = tokenOf(new Uint8Array(await file.arrayBuffer()))
    if (body?.token !== current) {
      throw new HttpError(409, 'the file changed since it was opened; reopen it and reapply')
    }

    const bytes = new TextEncoder().encode(content)
    await Bun.write(target, bytes)
    // Yours now: the pane stops colouring what the last turn changed in it. No turn is running
    // (guard 1), so nothing else writes TURN meanwhile.
    const was = await turnBefores(dir)
    const rel = relative(dir, target)
    if (rel in was) {
      delete was[rel]
      await writeJson(join(dir, TURN), was)
    }
    // Guard 3 is not here: it is the checkpoint. A hand edit is now revertible exactly like
    // a turn, which is the whole reason this endpoint waited for commit-per-turn to exist.
    await checkpoint(dir, `${COMMIT.edit}${path}`)
    // Same moment as a turn's: the app just changed under a running preview, so the card's
    // picture is now one edit out of date. Not awaited — the save is already done.
    void recordShot(slug)
    return c.json({ path, size: bytes.length, token: tokenOf(bytes) } satisfies Written)
  })
})

// Before the SPA fallback: an unmatched /api GET would otherwise be answered with
// index.html and a 200, which src/api.ts parses to null and hands back typed as T — the
// caller then dereferences null and the tree unmounts to a white rectangle. A mistyped
// endpoint is also the one thing a developer curling this API must be told about.
app.all('/api/*', () => {
  throw new HttpError(404, 'no such endpoint')
})

app.use('/assets/*', serveStatic({ root: './dist/client' }))
app.get('/favicon.svg', serveStatic({ path: './dist/client/favicon.svg' }))
// SPA fallback last: Vite's dev server does this for us, Hono must be told.
app.get('*', serveStatic({ path: './dist/client/index.html' }))
