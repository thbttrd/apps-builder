/**
 * The checks that need the server: spawn apps-builder on its own ports and projects
 * directory, then drive it over HTTP — the origin gate, projects and their first build, the
 * pods and their services, the fetch relay, HMR through the websocket relay, settings and
 * rename, the code pane, check_app on a live preview, the design routes, and the browser smoke.
 * Everything that runs without a server is in test/ (`bun run test`).
 *
 *   bun run check      (the build, then test/, then this)
 */
import { rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { smoke } from './browser-smoke'
import type { VersionInfo } from '../server/version'
import { tools } from '../server/tools'
import { checkApp } from '../server/pilot'
import { checkpoint, noteOutsideEdits } from '../server/git'
import { refused } from '../server/origin'
import { TRACE, trace } from '../server/trace'
import { MAX_BYTES, RelayError, isPrivate, relayFetch } from '../server/fetch-relay.mjs'
import { type DesignView, designPhase, gateFor, readDesign, takeDoc, takeMessage, writeDesign } from '../server/design'
import { CSP, checkDesign } from '../server/design-check'
import { chromePath } from '../server/shots'
import { GLM_CHAT, GOOD, SECTIONS, briefL, lit, repaint } from '../test/fixtures'

const PORT = 8897
const PREVIEW_PORT = 8898
const SECRET = 'check-secret'
const ORIGIN = 'check-origin'
const PROJECTS = join(import.meta.dir, '..', '.check-projects')
const HOST = 'demo-app.preview.localhost'

// Every request this harness sends arrives as if through the proxy, the way every real one does: apps-builder's
// own header (x-ab-origin; x-origin-auth is the cluster Gateway's, removed before the app), and the
// preview cookie a signed-in browser carries. Only the gate's own checks go out through `bare`.
const bare = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('x-ab-origin', ORIGIN)
  if (!headers.has('cookie')) headers.set('cookie', `ab_preview=${SECRET}`)
  return bare(input, { ...init, headers })
}) as typeof fetch

let failures = 0
function check(ok: boolean, what: string) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`)
  if (!ok) failures++
}

// Refuse a port something already answers on: the API spawned below would die on it unnoticed,
// and every check would run against whatever answered instead. On 8797/8798 that was the live
// dev instance, and the suite created, renamed and deleted its projects (the design log, the smoke
// that had skipped every run).
for (const port of [PORT, PREVIEW_PORT]) {
  if (await bare(`http://127.0.0.1:${port}/`).then(() => true, () => false)) {
    console.error(`port ${port} already answers: stop whatever holds it (a leftover check run?) and run again`)
    process.exit(1)
  }
}

// The preview image (deploy/preview.Dockerfile) carries the template's node_modules; podman mounts this
// tree's preview scripts over its own, so it is rebuilt only when the template's lockfile changes.
const LOCK = new Bun.CryptoHasher('sha256').update(await Bun.file(join(import.meta.dir, '..', 'template', 'bun.lock')).arrayBuffer()).digest('hex')
const PREVIEW_IMAGE = `localhost/apps-builder-preview:check-${LOCK.slice(0, 12)}`
if (Bun.spawnSync(['podman', 'image', 'exists', PREVIEW_IMAGE]).exitCode !== 0) {
  const args = ['build', '-q', '-f', 'deploy/preview.Dockerfile', '--build-arg', `AB_LOCK=${LOCK}`, '-t', PREVIEW_IMAGE, '.']
  if (Bun.spawnSync(['podman', ...args], { cwd: join(import.meta.dir, '..'), stdout: 'inherit', stderr: 'inherit' }).exitCode !== 0) {
    console.error(`could not build ${PREVIEW_IMAGE}`)
    process.exit(1)
  }
}

// A browser of its own, reached over CDP as the cluster's apps-builder reaches its browser container
// (AB_BROWSER_CDP): the server runs with a HOME that has no chromium, so its check_app and screenshots
// work only through this one. The suite's own in-process check_app goes through it too.
const cdpPort = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
const CDP = `http://127.0.0.1:${cdpPort.port}`
cdpPort.stop(true)
const browserProfile = join(import.meta.dir, '..', '.check-browser')
const cdpBrowser = Bun.spawn(
  [chromePath() ?? 'chromium', `--remote-debugging-port=${new URL(CDP).port}`, '--remote-debugging-address=127.0.0.1', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${browserProfile}`],
  { stdout: 'ignore', stderr: 'ignore' },
)
for (let i = 0; i < 100 && !(await bare(`${CDP}/json/version`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100)
process.env.AB_BROWSER_CDP = CDP
const chromelessHome = join(import.meta.dir, '..', '.check-home')
await rm(chromelessHome, { recursive: true, force: true })

const server = Bun.spawn([process.execPath, 'server/api.ts'], {
  cwd: join(import.meta.dir, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    PREVIEW_PORT: String(PREVIEW_PORT),
    AB_PREVIEW_SECRET: SECRET,
    // Set here, never inherited: bun auto-loads .env, and the dev value must not leak in.
    AB_ORIGIN_SECRET: ORIGIN,
    AB_PROJECTS_DIR: PROJECTS,
    AB_PREVIEW_DOMAIN: '',
    AB_PREVIEW_IMAGE: PREVIEW_IMAGE,
    AB_BROWSER_CDP: CDP,
    HOME: chromelessHome,
    // bun install's cache and podman's storage stay the real ones: only chromium is taken away.
    BUN_INSTALL_CACHE_DIR: join(process.env.HOME ?? '', '.bun', 'install', 'cache'),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '', '.local', 'share'),
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'),
    // bun auto-loads .env, so without this the key leaks in from the dev instance's file
    // and the "no key" assertion below silently tests something else.
    OPENROUTER_API_KEY: '',
  },
  stdout: 'inherit',
  stderr: 'inherit',
})

async function cleanup() {
  server.kill()
  cdpBrowser.kill()
  await rm(browserProfile, { recursive: true, force: true })
  await rm(chromelessHome, { recursive: true, force: true })
  await server.exited
  // Postgres's files belong to a uid of the pod's, which only podman unshare can remove.
  await Bun.spawn(['podman', 'unshare', 'rm', '-rf', join(PROJECTS, '.data')]).exited
  await rm(PROJECTS, { recursive: true, force: true })
}

try {
  // Ours, not just anyone's: alive as well as answering.
  await until(() => server.exitCode === null && fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok), 10_000, 'api up')

  // ── the origin gate: reaching a port proves nothing ──────────────────────
  // Any container on the dev server or the proxy and any VPN device reaches these ports without passing
  // the SSO proxy, so a request without its header, or with a wrong one of the same length,
  // gets nothing: the API, the UI, the dispatcher's proxy and forwardAuth's endpoint alike.
  const surfaces: [string, Record<string, string>][] = [
    [`http://127.0.0.1:${PORT}/api/projects`, {}],
    [`http://127.0.0.1:${PORT}/`, {}],
    [`http://127.0.0.1:${PREVIEW_PORT}/`, { host: HOST }],
    [`http://127.0.0.1:${PREVIEW_PORT}/_ab/auth`, { cookie: `ab_preview=${SECRET}` }],
  ]
  for (const [url, headers] of surfaces) {
    for (const origin of ['', 'check-origiX']) {
      const r = await bare(url, { headers: origin ? { ...headers, 'x-ab-origin': origin } : headers })
      check(r.status === 403, `${origin ? 'wrong' : 'no'} origin header: ${url} -> ${r.status}`)
    }
    // The cluster's stamp is not apps-builder's: its Gateway removes it before the app anyway.
    const theirs = await bare(url, { headers: { ...headers, 'x-origin-auth': ORIGIN } })
    check(theirs.status === 403, `x-origin-auth alone, right value: ${url} -> ${theirs.status}`)
  }
  // The websocket branch never reaches Hono, so it is proved on its own.
  const upgraded = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${PREVIEW_PORT}/`, {
      protocols: ['vite-hmr'],
      headers: { host: HOST },
    } as unknown as string[])
    s.onopen = () => (s.close(), resolve(true))
    s.onerror = () => resolve(false)
  })
  check(!upgraded, 'no origin header: the websocket upgrade is refused')
  check(refused(undefined, 'x') === 503 && refused('', '') === 503, 'an unset secret fails closed with 503')
  // Past the gate, forwardAuth answers on the cookie alone.
  const auth = (cookie: string) =>
    fetch(`http://127.0.0.1:${PREVIEW_PORT}/_ab/auth`, { headers: { cookie } }).then((r) => r.status)
  check((await auth('')) === 401, '/_ab/auth without the cookie -> 401')
  check((await auth(`ab_preview=${SECRET}`)) === 200, '/_ab/auth with it -> 200')
  // And the dispatcher asks for it itself, for every page and every HMR upgrade: on the cluster nothing
  // in front of it does (the proxy's forwardAuth goes with the cutover).
  const stamped = { host: HOST, 'x-ab-origin': ORIGIN }
  const noCookie = await bare(`http://127.0.0.1:${PREVIEW_PORT}/`, { headers: stamped })
  const wrongCookie = await bare(`http://127.0.0.1:${PREVIEW_PORT}/`, { headers: { ...stamped, cookie: 'ab_preview=nope' } })
  check(noCookie.status === 401 && wrongCookie.status === 401, `a preview page without the cookie, or a wrong one -> ${noCookie.status}, ${wrongCookie.status}`)
  const upgradedBare = await new Promise<boolean>((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${PREVIEW_PORT}/`, { protocols: ['vite-hmr'], headers: stamped } as unknown as string[])
    s.onopen = () => (s.close(), resolve(true))
    s.onerror = () => resolve(false)
  })
  check(!upgradedBare, 'an HMR upgrade without the cookie is refused')

  // ── version: the three places that carry it have to agree ────────────────
  // They did not, before this check existed — the tree said 0.1.0 while staging ran
  // v0.3.0 — and nothing else can see it. The app renders, the build passes, the deploy
  // succeeds, and the About screen announces the wrong release with total confidence.
  const declared = ((await Bun.file(join(import.meta.dir, '..', 'package.json')).json()) as {
    version: string
  }).version
  const reported = (await fetch(`http://127.0.0.1:${PORT}/api/version`).then((r) =>
    r.json(),
  )) as VersionInfo
  const newest = reported.entries.find((e) => e.version !== null)
  check(reported.version === declared, `/api/version ${reported.version} = package.json ${declared}`)
  check(newest?.version === declared, `CHANGELOG.md's newest entry ${newest?.version} = ${declared}`)
  check((newest?.sections.length ?? 0) > 0, `and it parsed into ${newest?.sections.length ?? 0} section(s)`)

  const created = (await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Demo App' })) as {
    slug: string
    port: number
    url: string
  }
  check(created.slug === 'demo-app', `slug "Demo App" -> "${created.slug}"`)
  check(typeof created.port === 'number' && created.port > 0, `vite reported port ${created.port}`)
  // Its picture, taken as it started, by the browser over CDP: the server has no chromium of its own.
  const cardAt = `http://127.0.0.1:${PORT}/api/projects/demo-app/screenshot`
  await until(async () => (await fetch(cardAt)).ok, 30_000, 'the new project has its picture')
  const card = new Uint8Array(await (await fetch(cardAt)).arrayBuffer())
  const view = new DataView(card.buffer)
  const [w, h] = card.length > 24 ? [view.getUint32(16), view.getUint32(20)] : [0, 0]
  check(card[1] === 0x50 && w === 960 && h === 600, `its card is a 960×600 PNG, from the browser over CDP -> ${w}×${h}`)

  // 409 on a duplicate, and the mkdir lock means the loser never half-creates a project
  const dup = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'demo app' }),
  })
  check(dup.status === 409, `duplicate slug -> ${dup.status}`)

  // ── the first build: what the workspace and History wait for ─────────────
  // Unbuilt while the newest commit to touch the app outside .apps-builder/ is the scaffold.
  const listed = async (slug: string) =>
    ((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as { slug: string; built: boolean }[]).find(
      (p) => p.slug === slug,
    )
  const timeline = async (slug: string) =>
    (await (await fetch(`http://127.0.0.1:${PORT}/api/projects/${slug}/history`)).json()) as {
      head: string
      snapshots: { sha: string; subject: string }[]
    }
  const drop = (slug: string) => fetch(`http://127.0.0.1:${PORT}/api/projects/${slug}`, { method: 'DELETE' })
  check((created as { built?: boolean }).built === false, 'a new project is not built: the create answers built: false')
  const scaffolded = await timeline('demo-app')
  check(scaffolded.snapshots.length === 0 && scaffolded.head !== '', `and History has nothing to show, though it has a HEAD -> ${scaffolded.snapshots.length}`)

  await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Build Rule' })
  const ruleDir = join(PROJECTS, 'build-rule')
  // A turn that only asked, or wrote the spec and the plan: .apps-builder/ and nothing else.
  await Bun.write(join(ruleDir, '.apps-builder/spec.json'), '{}')
  await checkpoint(ruleDir, 'turn 1: a question')
  check((await listed('build-rule'))?.built === false, 'a turn that touched only .apps-builder/ leaves it unbuilt')
  check((await timeline('build-rule')).snapshots.length === 0, 'and History still shows nothing: the app is the template')
  // Mid-turn, the listing calls it built once the turn has replaced the template's page — and only
  // once the running preview serves what "/" now shows. Written before a part it imports, vite
  // answers 500, and the frame would slide in holding its error overlay. Polled: the listing is
  // asked for as soon as a write lands, and vite's watcher hears of it a few ms after.
  const settles = async (slug: string, built: boolean) => {
    for (const end = Date.now() + 3000; Date.now() < end; await Bun.sleep(100)) if ((await listed(slug))?.built === built) return true
    return false
  }
  const ruleHome = join(ruleDir, 'src/Home.tsx')
  const ruleMain = join(ruleDir, 'src/main.tsx')
  const template = await Bun.file(ruleHome).text()
  const router = await Bun.file(ruleMain).text()
  await Bun.write(ruleHome, "import { Tip } from './Tip'\n\nexport default function Home() {\n  return <Tip />\n}\n")
  check(await settles('build-rule', false), 'Home.tsx rewritten before the part it imports: the preview cannot serve it, so not built yet')
  await Bun.write(join(ruleDir, 'src/Tip.tsx'), 'export function Tip() {\n  return <p>15%</p>\n}\n')
  check(await settles('build-rule', true), 'and once the part is on disk, built mid-turn, before any commit')
  // The other way a first build replaces the page, as six projects did: Home.tsx deleted, and "/"
  // routed to a page named for its job. Until main.tsx is rewired, it imports a file that is gone.
  await rm(ruleHome)
  check(await settles('build-rule', false), 'Home.tsx deleted while main.tsx still imports it: the preview cannot serve main.tsx, so not built')
  const rerouted = router.replace("import Home from './Home'", "import Market from './Market'").replace('<Home />', '<Market />')
  check(rerouted !== router && !rerouted.includes('Home'), 'the reroute fixture really takes the template page out of main.tsx')
  await Bun.write(join(ruleDir, 'src/Market.tsx'), 'export default function Market() {\n  return <h1>Market</h1>\n}\n')
  await Bun.write(ruleMain, rerouted)
  check(await settles('build-rule', true), 'and once main.tsx routes "/" to a page of its own that is on disk: built mid-turn')
  await Bun.write(ruleHome, template)
  await Bun.write(ruleMain, router)
  await rm(join(ruleDir, 'src/Market.tsx'))
  // Committed, the same rule: a turn that wrote anything but the page leaves the template at "/".
  await Bun.write(join(ruleDir, 'src/Tip.tsx'), 'export const tip = 0.15\n')
  await checkpoint(ruleDir, 'turn 2: a lib file')
  check(
    (await listed('build-rule'))?.built === false && (await timeline('build-rule')).snapshots.length === 0,
    'a turn that wrote a lib file and not the page leaves it unbuilt, History empty',
  )
  await Bun.write(ruleHome, 'export default function Home() {\n  return <h1>Tips</h1>\n}\n')
  const firstSha = await checkpoint(ruleDir, 'turn 3: the first build')
  check((await listed('build-rule'))?.built === true, 'the turn that replaces the page builds it')
  await Bun.write(join(ruleDir, 'src/Tip.tsx'), 'export const tip = 0.2\n')
  await checkpoint(ruleDir, 'turn 4: a change')
  const built = await timeline('build-rule')
  check(
    built.snapshots.map((s) => s.subject).join(' | ') === 'turn 4: a change | turn 3: the first build',
    `History starts at the first build: no scaffold, no turn before it -> ${built.snapshots.map((s) => s.subject).join(' | ')}`,
  )
  check(built.snapshots.at(-1)?.sha === firstSha, 'and its oldest entry is the first build\'s commit')
  // The trace (trace.ts) is never committed, so neither a checkpoint nor a restore touches it.
  await trace(ruleDir, { kind: 'turn', turn: 5 })
  const traceOnly = await checkpoint(ruleDir, 'turn 5: nothing but a trace line')
  await post(`http://127.0.0.1:${PORT}/api/projects/build-rule/restore`, { sha: firstSha })
  const traced = (await Bun.file(join(ruleDir, TRACE)).text()).trim().split('\n')
  check(
    traceOnly === null && traced.length === 1 && JSON.parse(traced[0]!).turn === 5,
    `trace.jsonl: a line is no commit, and a code+chat restore past it keeps it -> commit ${traceOnly}, ${traced.length} line`,
  )
  await drop('build-rule')

  // A design commit — code putting an approved DESIGN.md into the template (design.ts, approve)
  // — changes the app's files and is still not a build, and the model is told of it in a ◆ note,
  // not as an edit made outside the chat.
  await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Design Rule' })
  const designRuleDir = join(PROJECTS, 'design-rule')
  await Bun.write(join(designRuleDir, 'src/app.css'), "@import 'tailwindcss';\n@theme { --color-canvas: #faf9f5; }\n")
  await checkpoint(designRuleDir, 'design: Warm receipt, from Claude')
  check(
    (await listed('design-rule'))?.built === false && (await timeline('design-rule')).snapshots.length === 0,
    'a design commit changes the app and leaves it unbuilt: the chat stays alone, History empty',
  )
  check((await noteOutsideEdits(designRuleDir)) === null, 'and the next turn is not told the app was changed outside the chat')
  await Bun.write(join(designRuleDir, 'src/Home.tsx'), 'export default function Home() {\n  return <h1>Receipts</h1>\n}\n')
  await checkpoint(designRuleDir, 'turn 2: the first build')
  const designed = await timeline('design-rule')
  check(
    (await listed('design-rule'))?.built === true && designed.snapshots.map((s) => s.subject).join(' | ') === 'turn 2: the first build',
    `the first turn to replace the page builds it, and History starts there, not at the design -> ${designed.snapshots.map((s) => s.subject).join(' | ')}`,
  )
  await drop('design-rule')

  // Repos from before the scaffold commit open as they always did: built, History uncut.
  await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Legacy App' })
  const legacyDir = join(PROJECTS, 'legacy-app')
  const sh = (cmd: string[]) => Bun.spawn(cmd, { cwd: legacyDir, stdout: 'ignore', stderr: 'ignore' }).exited
  await rm(join(legacyDir, '.git'), { recursive: true, force: true })
  await sh(['git', 'init', '-q'])
  check((await listed('legacy-app'))?.built === true, 'a repo with no commits is built')
  await checkpoint(legacyDir, 'turn 1: from before the scaffold commit')
  check((await listed('legacy-app'))?.built === true, 'so is one whose first commit is not the scaffold')
  check((await timeline('legacy-app')).snapshots.length === 1, 'and its History is not cut')
  await drop('legacy-app')

  // Made from a prompt, named from it: here there is no key, so by its first words.
  const byPrompt = (await post(`http://127.0.0.1:${PORT}/api/projects`, {
    prompt: 'A tip calculator for splitting bills with friends',
  })) as { slug: string; built: boolean }
  check(byPrompt.slug === 'a-tip-calculator-for-splitting', `a project made from a prompt is named from it -> ${byPrompt.slug}`)
  check(byPrompt.built === false, 'and it is not built')
  const again = (await post(`http://127.0.0.1:${PORT}/api/projects`, {
    prompt: 'A tip calculator for splitting the rent',
  })) as { slug: string }
  check(again.slug === 'a-tip-calculator-for-splitting-2', `a made-up name that is taken gets -2, not a 409 -> ${again.slug}`)
  const typed = (await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Typed Name', prompt: 'a tip calculator' })) as {
    slug: string
  }
  check(typed.slug === 'typed-name', `a typed name wins over the prompt -> ${typed.slug}`)
  // A create must not fail for want of a name: a prompt in a script slugify drops, with no
  // describer to put it in Latin letters, is still made, and accents keep their letters.
  const foreign = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '家計簿を つける アプリ' }),
  })
  const foreignSlug = foreign.ok ? ((await foreign.json()) as { slug: string }).slug : ''
  check(foreign.status === 201 && foreignSlug === 'new-app', `a prompt in another script -> ${foreign.status} ${foreignSlug}`)
  const accented = (await post(`http://127.0.0.1:${PORT}/api/projects`, { prompt: 'Un carnet pour mon café' })) as {
    slug: string
  }
  check(accented.slug === 'un-carnet-pour-mon-cafe', `accents come off, the letters stay -> ${accented.slug}`)
  for (const s of [foreignSlug, accented.slug]) if (s) await drop(s)
  const neither = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '   ' }),
  })
  check(neither.status === 400, `no name and a blank prompt -> ${neither.status}`)

  // More on the start page: a project is made with its settings, so its first turn runs on
  // them, and a setting a PATCH would refuse makes nothing at all.
  type Made = { slug: string; model?: string; gate?: string; design?: boolean; params?: { temperature?: number } }
  const madeWith = (await post(`http://127.0.0.1:${PORT}/api/projects`, {
    prompt: 'A plant diary',
    settings: { model: 'z-ai/glm-5.3', gate: 'plan', design: true, params: { temperature: 0.3 } },
  })) as Made
  const said = ({ model, gate, design, params }: Made | undefined = { slug: '' }) =>
    JSON.stringify({ model, gate, design, t: params?.temperature })
  const expected = JSON.stringify({ model: 'z-ai/glm-5.3', gate: 'plan', design: true, t: 0.3 })
  check(said(madeWith) === expected, `a create's settings are in its answer -> ${said(madeWith)}`)
  const madeListed = ((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as Made[]).find(
    (p) => p.slug === madeWith.slug,
  )
  check(said(madeListed) === expected, `and stored, as the listing reads them -> ${said(madeListed)}`)
  const namedWith = (await post(`http://127.0.0.1:${PORT}/api/projects`, {
    name: 'Named With',
    prompt: 'a tip calculator',
    settings: { design: true },
  })) as Made
  check(namedWith.slug === 'named-with' && namedWith.design === true, `a typed name's create takes them too -> ${namedWith.slug} ${namedWith.design}`)
  const badCreate = await fetch(`http://127.0.0.1:${PORT}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad Settings', settings: { design: true, gate: 'sometimes' } }),
  })
  const badDir = await stat(join(PROJECTS, 'bad-settings')).then(() => true, () => false)
  check(badCreate.status === 400 && !badDir, `a bad setting refuses the create -> ${badCreate.status}, directory made: ${badDir}`)
  for (const s of [madeWith.slug, namedWith.slug]) await drop(s)
  const house = (await (await fetch(`http://127.0.0.1:${PORT}/api/house`)).json()) as { defaultModel?: string; defaultLookModel?: string }
  check(
    house.defaultModel === 'z-ai/glm-5.3' && house.defaultLookModel === 'z-ai/glm-5.3-flash',
    `GET /api/house: what a project with no settings runs on, for the start page -> ${JSON.stringify(house)}`,
  )
  for (const s of [byPrompt.slug, again.slug, typed.slug]) await drop(s)

  // ── checkpoints: a project with no commits has no undo ───────────────────
  const git = async (args: string[], slug = 'demo-app') => {
    const p = Bun.spawn(['git', ...args], { cwd: join(PROJECTS, slug), stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out.trim()
  }
  check((await git(['rev-list', '--count', 'HEAD'])) === '1', 'a new project has one commit')
  check((await git(['log', '-1', '--format=%s'])) === 'scaffold', 'and it is the scaffold baseline')
  check(
    (await git(['status', '--porcelain', '--', '.', ':(exclude).apps-builder/pod.yaml'])) === '',
    'its working tree is clean at creation — but for the pod\'s spec, which is never committed',
  )
  // node_modules is the reason .gitignore exists; committing it would be minutes per turn.
  check(!(await git(['ls-files'])).includes('node_modules/'), 'node_modules is not committed')

  // The dispatcher routes on Host alone; nothing else distinguishes one preview.
  const page = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`, { headers: { host: HOST } })
  const html = await page.text()
  check(page.ok, `dispatcher GET / -> ${page.status}`)
  check(html.includes('/src/main.tsx'), 'dispatcher served the project index.html')
  check(!html.includes('not allowed'), 'vite did not block the Host header')

  // ── the preview's pod: the app's code runs with nothing of the host's ─────
  // Asked from inside the running pod, with the pod's own node: apps-builder's environment is
  // not there, and neither the LAN (this host's own address, where the API listens), the
  // host, nor the internet answers. Only the relay gets out, and its refusals below prove
  // the line carries it.
  const podOf = async (slug: string) =>
    (Bun.YAML.parse(await Bun.file(join(PROJECTS, slug, '.apps-builder', 'pod.yaml')).text()) as { metadata: { name: string } }).metadata.name
  const demoPod = await podOf('demo-app')
  const inPod = async (cmd: string[]) => {
    const p = Bun.spawn(['podman', 'exec', `${demoPod}-preview`, ...cmd], { stdout: 'pipe', stderr: 'pipe' })
    return (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
  }
  const podEnv = await inPod(['env'])
  // AB_CONTROL_TOKEN is the pod's own (pod.ts): the control port's, made for this start.
  const leaked = podEnv.split('\n').filter((l) => /^(AB_|OPENROUTER)/.test(l) && !l.startsWith('AB_CONTROL_TOKEN='))
  check(
    podEnv.includes('NODE_VERSION=') && /^AB_CONTROL_TOKEN=[0-9a-f]{48}$/m.test(podEnv) && leaked.length === 0,
    `pod: none of apps-builder's environment is in it, only its control token -> ${leaked.map((l) => l.split('=')[0]).join(', ') || 'none'}`,
  )
  const route = Bun.spawnSync(['ip', '-4', 'route', 'get', '1.1.1.1']).stdout.toString()
  const lan = route.match(/\bsrc (\S+)/)?.[1] ?? '192.168.100.1'
  const probe = `for (const u of process.argv.slice(1)) await fetch(u, { signal: AbortSignal.timeout(4000) }).then((r) => console.log('REACHED', u, r.status), () => console.log('refused', u))`
  const egress = await inPod(['node', '--input-type=module', '-e', probe, `http://${lan}:${PORT}/api/health`, `http://host.containers.internal:${PORT}/api/health`, 'https://example.com/'])
  check(
    egress.split('\n').filter((l) => l.startsWith('refused')).length === 3 && !egress.includes('REACHED'),
    `pod: the LAN (${lan}), the host and the internet all refused from inside -> ${JSON.stringify(egress.trim())}`,
  )

  // ── services: a server, Redis and Postgres beside the preview, on request ─────
  // Through POST /services, which is add_service's own function: the containers join the pod,
  // the server answers /api through the dispatcher, both databases round-trip, an edit to the
  // server is live, and the server is as shut in as the preview. Then a rename keeps the data
  // and a delete takes it.
  const svc = 'services-check'
  await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Services Check' })
  const svcDir = join(PROJECTS, svc)
  const specOf = async (slug: string) =>
    Bun.YAML.parse(await Bun.file(join(PROJECTS, slug, '.apps-builder', 'pod.yaml')).text()) as { metadata: { name: string }; spec: { containers: { name: string }[] } }
  const containersOf = async (slug: string) => (await specOf(slug)).spec.containers.map((c) => c.name).join(',')
  check((await containersOf(svc)) === 'preview', `services: a new app is the preview alone -> ${await containersOf(svc)}`)
  // Its table made as it loads, as the model writes them: a server that started before
  // Postgres could answer failed right there, and stayed failed.
  const serverSrc = (ping: string) => `import { redis, sql } from 'bun'
await sql\`create table if not exists visits (n int)\`
export default {
  async fetch(req: Request) {
    const path = new URL(req.url).pathname
    if (path === '/api/ping') return new Response(${JSON.stringify(ping)})
    if (path === '/api/hits') return new Response(String(await redis.incr('hits')))
    if (path === '/api/pg') return new Response(String((await sql\`select 40 + 2 as n\`)[0].n))
    if (path === '/api/seen') return Response.json({ ab: req.headers.get('x-ab-origin'), theirs: req.headers.get('x-origin-auth'), cookie: req.headers.get('cookie') })
    return new Response('nope', { status: 404 })
  },
}
`
  await Bun.write(join(svcDir, 'server', 'index.ts'), serverSrc('pong'))
  const addService = (slug: string, service: string) =>
    fetch(`http://127.0.0.1:${PORT}/api/projects/${slug}/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service }),
    })
  check((await addService(svc, 'mongo')).status === 400, 'services: one not on the list -> 400')
  const addedRedis = ((await (await addService(svc, 'redis')).json()) as { added: string[] }).added.join(',')
  const addedPg = ((await (await addService(svc, 'postgres')).json()) as { added: string[] }).added.join(',')
  const addedAgain = ((await (await addService(svc, 'server')).json()) as { added: string[] }).added.join(',')
  check(
    addedRedis === 'server,redis' && addedPg === 'postgres' && addedAgain === '',
    `services: redis brings the server, postgres joins them, the server again adds nothing -> ${addedRedis} | ${addedPg} | ${addedAgain || 'nothing'}`,
  )
  const svcMeta = (await Bun.file(join(svcDir, '.apps-builder', 'project.json')).json()) as { services?: string[] }
  check(
    (await containersOf(svc)) === 'preview,server,redis,postgres' && svcMeta.services?.join(',') === 'server,redis,postgres',
    `services: the pod and project.json carry them -> ${await containersOf(svc)} · ${svcMeta.services?.join(',')}`,
  )
  const viaApp = (slug: string, path: string) =>
    fetch(`http://127.0.0.1:${PREVIEW_PORT}${path}`, { headers: { host: `${slug}.preview.localhost` } }).then(
      async (r) => (r.ok ? r.text() : `${r.status}`),
      () => 'unreachable',
    )
  await until(async () => (await viaApp(svc, '/api/ping')) === 'pong', 30_000, 'the server answering /api/ping')
  const hits = [await viaApp(svc, '/api/hits'), await viaApp(svc, '/api/hits')]
  check(hits.join(',') === '1,2', `services: /api reaches the server through the dispatcher, and Redis counts -> ${hits.join(',')}`)
  // Neither origin header nor the preview cookie reaches the app's code: the cookie opens every preview,
  // and the server could send it anywhere through the relay. The app's own cookies still arrive.
  const appSaw = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/api/seen`, {
    headers: { host: `${svc}.preview.localhost`, 'x-origin-auth': 'stamp', cookie: `theme=dark; ab_preview=${SECRET}; n=1` },
  }).then((r) => r.json() as Promise<{ ab: string | null; theirs: string | null; cookie: string | null }>, () => null)
  check(
    appSaw?.ab === null && appSaw?.theirs === null && appSaw?.cookie === 'theme=dark; n=1',
    `services: the app's server sees no origin header and no ab_preview, its own cookies kept -> ${JSON.stringify(appSaw)}`,
  )
  await until(async () => (await viaApp(svc, '/api/pg')) === '42', 30_000, 'postgres answering through the server')
  check(true, 'services: and Postgres answers a query through it')
  const editedAt = Date.now()
  await Bun.write(join(svcDir, 'server', 'index.ts'), serverSrc('pong 2'))
  await until(async () => (await viaApp(svc, '/api/ping')) === 'pong 2', 10_000, 'the edited server')
  // The restart loop polls every 0.5 s (pod.ts): under gVisor a push is not signalled to the server's
  // container, so `bun --watch` (127 ms) never heard it.
  const liveIn = Date.now() - editedAt
  check(liveIn < 2000, `services: an edit to server/index.ts is live in ${liveIn} ms (< 2000)`)
  const svcPod = (await specOf(svc)).metadata.name
  const inServer = async (cmd: string[]) => {
    const p = Bun.spawn(['podman', 'exec', `${svcPod}-server`, ...cmd], { stdout: 'pipe', stderr: 'pipe' })
    return (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
  }
  const serverEnv = await inServer(['env'])
  check(
    /^PORT=3000$/m.test(serverEnv) && /^REDIS_URL=/m.test(serverEnv) && /^DATABASE_URL=/m.test(serverEnv) && !/^(AB_|OPENROUTER)/m.test(serverEnv),
    `services: the server has its port and its databases, and none of apps-builder's environment -> ${serverEnv.split('\n').filter((l) => /^(PORT|REDIS_URL|DATABASE_URL|AB_|OPENROUTER)/.test(l)).join(' ')}`,
  )
  const serverEgress = await inServer(['bun', '-e', probe, `http://${lan}:${PORT}/api/health`, `http://host.containers.internal:${PORT}/api/health`, 'https://example.com/'])
  check(
    serverEgress.split('\n').filter((l) => l.startsWith('refused')).length === 3 && !serverEgress.includes('REACHED'),
    `services: the LAN, the host and the internet all refused from the server too -> ${JSON.stringify(serverEgress.trim())}`,
  )
  // The server runs the model's code, and the host runs git and the project's tsc here: a hook
  // it planted in .git would run on the host at the next commit.
  const planted = await inServer(['sh', '-c', 'touch /app/ab-planted && echo WROTE || echo refused'])
  check(planted.includes('refused') && !planted.includes('WROTE'), `services: the server cannot write the pod's /app -> ${JSON.stringify(planted.trim())}`)
  // The pod's /app is a copy apps-builder pushes into: nothing written there reaches the project
  // the host runs git and tsc in (the hole #43 closed with a read-only mount, now closed by design).
  const p = Bun.spawn(['podman', 'exec', `${svcPod}-preview`, 'sh', '-c', 'mkdir -p /app/.git/hooks && echo x > /app/.git/hooks/pre-commit && echo x > /app/from-pod && echo WROTE'], { stdout: 'pipe', stderr: 'pipe' })
  const wrote = await new Response(p.stdout).text()
  const reached = (await stat(join(svcDir, 'from-pod')).then(() => true, () => false)) || (await stat(join(svcDir, '.git', 'hooks', 'pre-commit')).then(() => true, () => false))
  check(wrote.includes('WROTE') && !reached, `services: what the pod writes in /app never reaches the host's project -> wrote ${wrote.includes('WROTE')}, reached ${reached}`)
  // The control port's token is the preview container's alone: the server, on the same loopback,
  // runs the model's code.
  const tokenSeen = (await inServer(['sh', '-c', "cat /proc/*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c AB_CONTROL_TOKEN"])).trim()
  check(tokenSeen === '0', `services: no process the server's container sees holds AB_CONTROL_TOKEN -> ${tokenSeen}`)
  // podman names a kube emptyDir's volume after the spec's name: every pod's `app` was one volume, so
  // each preview's files landed in every other's /app (found 2026-10-21). demo-app has no server/.
  const shared = await inPod(['sh', '-c', 'test -e /app/server/index.ts && echo SHARED || echo own'])
  check(shared.trim() === 'own', `services: each preview has an /app of its own -> ${shared.trim()}`)
  // demo-app's pod, from this app's server: each pod is on a network of its own. On one bridge
  // for all, a server reached every other preview's vite — its source, its /api.
  const demoIp = (
    await inPod(['node', '-p', "Object.values(require('node:os').networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address ?? ''"])
  ).trim()
  const across = await inServer(['bun', '-e', probe, `http://${demoIp}:5173/`])
  check(
    /^\d+\.\d+\.\d+\.\d+$/.test(demoIp) && across.includes('refused') && !across.includes('REACHED'),
    `services: another app's pod (${demoIp || 'no address'}) refused from the server -> ${JSON.stringify(across.trim())}`,
  )
  const published = Bun.spawnSync(['podman', 'port', `${svcPod}-preview`]).stdout.toString().trim().split('\n')
  check(
    published.length === 2 && published.every((l) => /^517[34]\/tcp -> 127\.0\.0\.1:\d+$/.test(l)) && published.some((l) => l.startsWith('5174/tcp')),
    `services: only vite's and the control port are published, on 127.0.0.1, not a database's -> ${published.join(' | ')}`,
  )
  const control = `http://${published.find((l) => l.startsWith('5174/tcp'))!.split(' -> ')[1]}`
  const noToken = [
    (await bare(`${control}/_ab/push`, { method: 'POST', body: JSON.stringify({ files: { 'x.txt': 'eA==' } }) })).status,
    (await bare(`${control}/_ab/line`)).status,
  ]
  check(noToken.join(',') === '401,401', `services: a push and a line poll without the token -> ${noToken.join(',')}`)
  const svcData = join(PROJECTS, '.data', svc)
  const dataThere = async (dir: string) => (await stat(join(dir, 'redis')).then(() => true, () => false)) && (await stat(join(dir, 'postgres')).then(() => true, () => false))
  check(await dataThere(svcData), 'services: the databases\' data is beside the project, not in it')
  await fetch(`http://127.0.0.1:${PORT}/api/projects/${svc}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Services Moved' }),
  })
  const moved = 'services-moved'
  await until(async () => (await viaApp(moved, '/api/pg')) === '42', 30_000, 'the renamed app\'s server')
  const hitsAfter = await viaApp(moved, '/api/hits')
  check(
    hitsAfter === '3' && (await dataThere(join(PROJECTS, '.data', moved))) && !(await dataThere(svcData)),
    `services: a rename moves the data, and Redis counts on from where it was -> ${hitsAfter}`,
  )
  const movedPod = (await specOf(moved)).metadata.name
  // Its preview dies first: gone from `running`, while the server and the databases go on. The
  // delete has to take them anyway — as a rename has to, or it starts a second Postgres on the
  // data the first still has open.
  Bun.spawnSync(['podman', 'kill', `${movedPod}-preview`])
  await until(
    async () => !((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as { slug: string; running: boolean }[]).find((p) => p.slug === moved)?.running,
    10_000,
    'services: a preview that died is no longer listed as running',
  )
  const deleteStarted = Date.now()
  await fetch(`http://127.0.0.1:${PORT}/api/projects/${moved}`, { method: 'DELETE' })
  const deleteMs = Date.now() - deleteStarted
  check(
    (await Bun.spawn(['podman', 'pod', 'exists', movedPod]).exited) === 1 && !(await stat(join(PROJECTS, '.data', moved)).then(() => true, () => false)),
    `services: a delete takes the pod and the data, in ${deleteMs} ms`,
  )

  const unknown = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`, {
    headers: { host: 'nope.preview.localhost' },
  })
  check(unknown.status === 503, `unknown slug -> ${unknown.status}`)

  // ── the preview image's node_modules: a project must carry the template's lockfile ─────
  // Its node_modules is the image's (deploy/preview.Dockerfile), installed from the template's lock: a
  // project whose bun.lock differs would run against packages it did not pin, so it is refused, saying why.
  const locked = 'lock-check'
  await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Lock Check' })
  const lockedPod = (await specOf(locked)).metadata.name
  await Bun.write(join(PROJECTS, locked, 'bun.lock'), `${await Bun.file(join(PROJECTS, locked, 'bun.lock')).text()}\n`)
  Bun.spawnSync(['podman', 'pod', 'rm', '--force', lockedPod])
  await until(
    async () => !((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as { slug: string; running: boolean }[]).find((p) => p.slug === locked)?.running,
    10_000,
    'lock-check stopped',
  )
  const refusedStart = await fetch(`http://127.0.0.1:${PORT}/api/projects/${locked}/start`, { method: 'POST' })
  const refusedWhy = await refusedStart.text()
  check(refusedStart.status === 409 && refusedWhy.includes('bun.lock'), `a project whose bun.lock is not the template's is refused at start -> ${refusedStart.status} ${refusedWhy.slice(0, 120)}`)
  await fetch(`http://127.0.0.1:${PORT}/api/projects/${locked}`, { method: 'DELETE' })

  // ── /_ab/fetch: the preview's way out to other sites ─────────────────────
  // Mounted by preview-vite.mjs on every preview, so it is asked for through the
  // dispatcher like any page. Its happy path needs a public site, which a check cannot
  // count on; what it refuses is what proves it is there, and aimed at apps-builder's own
  // API, those refusals are the point of it.
  const viaRelay = (query: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${PREVIEW_PORT}/_ab/fetch${query}`, { ...init, headers: { host: HOST } })
  const ownApi = await viaRelay(`?url=${encodeURIComponent(`http://127.0.0.1:${PORT}/api/projects`)}`)
  check(ownApi.status === 403, `relay: apps-builder's own API by IP -> ${ownApi.status}`)
  check(ownApi.headers.get('x-ab-relay-error') === '1', 'relay: and the refusal is marked as the relay\'s own')
  check((await ownApi.text()).includes('not on the public internet'), 'relay: with a sentence saying why')
  const byName = await viaRelay(`?url=${encodeURIComponent(`http://localhost:${PORT}/api/projects`)}`)
  check(byName.status === 403, `relay: the same API by a name that resolves to loopback -> ${byName.status}`)
  const metadata = await viaRelay(`?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`)
  check(metadata.status === 403, `relay: the link-local metadata address -> ${metadata.status}`)
  check((await viaRelay('')).status === 400, 'relay: no url -> 400')
  check((await viaRelay(`?url=${encodeURIComponent('file:///etc/passwd')}`)).status === 400, 'relay: file:// -> 400')
  check((await viaRelay('?url=x', { method: 'POST' })).status === 405, 'relay: POST -> 405')
  // Every answer leaves through one send(), so a refusal carrying these proves a relayed
  // site does too: opened as a page, it runs nothing on the preview's origin.
  check(
    ownApi.headers.get('content-security-policy')?.startsWith('sandbox') === true &&
      ownApi.headers.get('x-content-type-options') === 'nosniff',
    'relay: its answers are sandboxed, so a relayed page cannot run as the preview',
  )
  // A path new URL cannot parse, straight to vite's port: Bun's fetch folds a leading `//`
  // into `/`, and the dispatcher forwards with it, so only a raw request line gets there.
  // Before the guard it hung for good (under bun; the host's node dies instead).
  const rawGet = (path: string) =>
    new Promise<string>((resolve) => {
      const socket = connect(created.port, '127.0.0.1', () =>
        socket.write(`GET ${path} HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n`),
      )
      let head = ''
      socket.setTimeout(5000, () => socket.destroy())
      socket.on('data', (d) => (head += d))
      socket.on('error', () => {})
      socket.on('close', () => resolve(head.split('\r\n')[0] ?? ''))
    })
  const unparsable = await rawGet('//[')
  check(unparsable.startsWith('HTTP/1.1 '), `relay: a path new URL cannot parse is still answered -> ${unparsable || 'nothing in 5s'}`)
  check((await viaRelay('')).status === 400, 'relay: and the preview is still up after it')

  // The fetch itself, against a local upstream: the one place the private-address rule is
  // swapped out, and only for 127.0.0.1 — 127.0.0.2 stays refused, to prove every hop is
  // judged and not only the first.
  const upstream = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === '/feed') {
        return new Response(Bun.gzipSync(new TextEncoder().encode('<rss><channel><title>t</title></channel></rss>')), {
          headers: { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' },
        })
      }
      if (u.pathname === '/moved') return new Response(null, { status: 301, headers: { location: '/feed' } })
      if (u.pathname === '/loop') return new Response(null, { status: 302, headers: { location: '/loop' } })
      if (u.pathname === '/away') return Response.redirect(`http://127.0.0.2:${u.port}/feed`, 302)
      if (u.pathname === '/huge') return new Response(new Uint8Array(MAX_BYTES + 1))
      if (u.pathname === '/echo') return Response.json(Object.fromEntries(req.headers))
      return new Response('gone', { status: 404 })
    },
  })
  const local = { isPrivate: (ip: string) => ip.replace(/^\[|\]$/g, '') !== '127.0.0.1' }
  const at = (path: string) => `http://127.0.0.1:${upstream.port}${path}`
  const fromUpstream = (path: string, headers?: Record<string, string>) =>
    relayFetch(at(path), { ...local, headers }).catch((e: RelayError) => e)
  try {
    const moved = await fromUpstream('/moved')
    check(!(moved instanceof Error) && moved.status === 200, 'relayFetch: a redirect is followed')
    check(!(moved instanceof Error) && moved.body.toString().startsWith('<rss>'), 'relayFetch: and a gzipped body comes back decoded')
    check(!(moved instanceof Error) && moved.headers['x-ab-final-url'] === at('/feed'), 'relayFetch: x-ab-final-url is where it ended up')
    check(!(moved instanceof Error) && moved.headers['content-type'] === 'application/rss+xml', 'relayFetch: with the site\'s content-type')
    const missing = await fromUpstream('/nope')
    check(!(missing instanceof Error) && missing.status === 404, 'relayFetch: the site\'s own 404 is passed through, not turned into an error')
    const away = await fromUpstream('/away')
    check(away instanceof RelayError && away.status === 403, 'relayFetch: a redirect to a private address is refused at that hop')
    const loop = await fromUpstream('/loop')
    check(loop instanceof RelayError && loop.message.includes('redirected more than'), 'relayFetch: a redirect loop ends')
    const huge = await fromUpstream('/huge')
    check(huge instanceof RelayError && huge.message.includes('larger than'), `relayFetch: a body over ${MAX_BYTES / 1024 / 1024} MB is refused`)
    const echo = await fromUpstream('/echo', { 'user-agent': 'Browser/1.0', cookie: 'ab_preview=secret', 'x-origin-auth': 'stamp' })
    const sent = echo instanceof Error ? {} : (JSON.parse(echo.body.toString()) as Record<string, string>)
    check(sent['user-agent'] === 'Browser/1.0', 'relayFetch: the browser\'s user-agent is passed on')
    check(!sent.cookie && !sent['x-origin-auth'], 'relayFetch: its cookies and the origin stamp are not')
    const defaults = await relayFetch(at('/feed')).catch((e: RelayError) => e)
    check(defaults instanceof RelayError && defaults.status === 403, 'relayFetch: with the real rule, 127.0.0.1 itself is refused')
  } finally {
    upstream.stop(true)
  }
  const privateCases: [string, boolean][] = [
    ['127.0.0.1', true], ['10.0.0.1', true], ['100.64.0.1', true], ['169.254.1.2', true], ['172.16.0.1', true],
    ['172.32.0.1', false], ['192.168.100.76', true], ['8.8.8.8', false], ['::1', true], ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false], ['64:ff9b::a00:1', true], ['fd00::1', true], ['fe80::1%eth0', true], ['2a01:cb00::1', false],
  ]
  const misjudged = privateCases.filter(([ip, want]) => isPrivate(ip) !== want).map(([ip]) => ip)
  check(misjudged.length === 0, `isPrivate: ${privateCases.length} addresses judged right${misjudged.length ? `, not ${misjudged.join(', ')}` : ''}`)

  // ── the silent failure: HMR over the relayed websocket ────────────────────
  const ws = new WebSocket(`ws://127.0.0.1:${PREVIEW_PORT}/`, {
    protocols: ['vite-hmr'],
    headers: { host: HOST, 'x-ab-origin': ORIGIN, cookie: `ab_preview=${SECRET}` },
  } as unknown as string[])
  const messages: string[] = []
  ws.onmessage = (e) => messages.push(String(e.data))
  await until(() => ws.readyState === WebSocket.OPEN, 10_000, 'hmr websocket opened through the relay')
  check(ws.protocol === 'vite-hmr', `subprotocol echoed back: "${ws.protocol}"`)
  await until(() => messages.some((m) => m.includes('"connected"')), 10_000, 'vite sent {"type":"connected"}')

  const home = join(PROJECTS, 'demo-app', 'src', 'Home.tsx')
  // Assert the fixture before asserting the behaviour: String.replace with no match
  // returns the string unchanged, so rewording the template's placeholder h1 would leave
  // this writing the same bytes. vite's watcher fires on the mtime alone, "update" still
  // arrives, and the one guard against a silently dead HMR relay proves nothing.
  const before = await Bun.file(home).text()
  const after = before.replace('New app', 'Edited app')
  check(after !== before, 'the HMR fixture really changes Home.tsx')
  await Bun.write(home, after)
  await until(
    () => messages.some((m) => m.includes('"update"')),
    15_000,
    'editing Home.tsx pushed an HMR update through the relay',
  )
  // apps-builder's own files are not the app's. A turn rewrites chat.json and project.json after
  // every step, and Tailwind's vite plugin, which scans every file git keeps for class names,
  // answered each write with a full reload: the preview reloaded at every step of every turn.
  // Tailwind watches what it scanned when it last built the app's CSS, and a page loaded after the
  // first turn has it scan .apps-builder/ too: asked for afresh here, as such a page would.
  const demoMeta = join(PROJECTS, 'demo-app', '.apps-builder', 'project.json')
  await Bun.write(demoMeta, await Bun.file(demoMeta).text().catch(() => '{}'))
  await fetch(`http://127.0.0.1:${created.port}/src/app.css?scanned=${Date.now()}`).then((r) => r.text())
  await Bun.sleep(500)
  messages.length = 0
  await Bun.write(demoMeta, await Bun.file(demoMeta).text())
  await Bun.sleep(1500)
  check(!messages.some((m) => m.includes('full-reload')), `a write to .apps-builder/ leaves the preview be -> ${messages.join(' ') || 'nothing sent'}`)
  ws.close()

  // A dead vite must deregister itself, or the slug 503s forever with no explanation.
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as {
    slug: string
    running: boolean
  }[]
  check(list.length === 1 && list[0]?.running === true, 'GET /api/projects lists it as running')

  // A slug reaches the filesystem; slugify() collapses traversal, so a slug that is not
  // its own slugify is refused outright.
  const traversal = await fetch(`http://127.0.0.1:${PORT}/api/projects/${encodeURIComponent('../../etc')}/start`, {
    method: 'POST',
  })
  check(traversal.status === 400, `traversal slug -> ${traversal.status}`)

  const noKey = await fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hi' }),
  })
  check(noKey.status === 503, `chat without OPENROUTER_API_KEY -> ${noKey.status}`)

  // ── per-project settings: model, rename, spend ───────────────────────────
  const patch = (slug: string, body: unknown) =>
    fetch(`http://127.0.0.1:${PORT}/api/projects/${slug}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  // Bun.write creates parent directories, so an unguarded metadata write on an unknown
  // slug would create the project it was describing. Both must refuse.
  const ghost = await patch('ghost', { model: 'x' })
  check(ghost.status === 404, `PATCH an unknown slug -> ${ghost.status}`)
  check(!(await Bun.file(join(PROJECTS, 'ghost', '.apps-builder/project.json')).exists()), 'it created nothing on disk')
  const escape = await patch(encodeURIComponent('../../etc'), { model: 'x' })
  check(escape.status === 400, `PATCH a traversal slug -> ${escape.status}`)

  await patch('demo-app', { model: 'z-ai/glm-5.3' })
  const withModel = (await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as {
    slug: string
    model?: string
    usd: number
    turns: number
  }[]
  check(withModel[0]?.model === 'z-ai/glm-5.3', `model persisted -> ${withModel[0]?.model}`)
  check(withModel[0]?.usd === 0 && withModel[0]?.turns === 0, 'spend starts at $0 / 0 turns')
  // The gate: 'step' or 'plan', anything else refused before anything is written.
  const badGate = await patch('demo-app', { gate: 'sometimes' })
  const withGate = (await (await patch('demo-app', { gate: 'plan' })).json()) as { gate?: string; model?: string }
  check(
    badGate.status === 400 && withGate.gate === 'plan' && withGate.model === 'z-ai/glm-5.3',
    `gate: "sometimes" -> ${badGate.status}; "plan" is kept, beside the model -> ${JSON.stringify(withGate)}`,
  )
  // Propose design: true or false, and off is stored as absent.
  const badDesign = await patch('demo-app', { design: 'yes' })
  const designOn = (await (await patch('demo-app', { design: true })).json()) as { design?: boolean; gate?: string }
  const designOff = (await (await patch('demo-app', { design: false })).json()) as { design?: boolean }
  check(
    badDesign.status === 400 && designOn.design === true && designOn.gate === 'plan' && designOff.design === undefined,
    `design: "yes" -> ${badDesign.status}; true is kept beside the gate, false clears it -> ${designOn.gate} ${designOn.design} ${designOff.design}`,
  )

  // Rename really moves the directory, so the slug — and the preview hostname — change.
  const renamed = (await (await patch('demo-app', { name: 'Renamed App' })).json()) as {
    slug: string
    running: boolean
    model?: string
  }
  check(renamed.slug === 'renamed-app', `rename "Renamed App" -> "${renamed.slug}"`)
  check(renamed.running, 'preview came back up under the new slug')
  check(renamed.model === 'z-ai/glm-5.3', 'model survived the rename')
  check(await Bun.file(join(PROJECTS, 'renamed-app', 'package.json')).exists(), 'directory moved on disk')
  check(!(await Bun.file(join(PROJECTS, 'demo-app', 'package.json')).exists()), 'old directory is gone')

  const atNewHost = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`, {
    headers: { host: 'renamed-app.preview.localhost' },
  })
  check(atNewHost.ok, `new hostname serves -> ${atNewHost.status}`)
  const atOldHost = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`, { headers: { host: HOST } })
  check(atOldHost.status === 503, `old hostname -> ${atOldHost.status}`)

  await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'other' })
  const clash = await patch('renamed-app', { name: 'other' })
  check(clash.status === 409, `rename onto an existing slug -> ${clash.status}`)
  await fetch(`http://127.0.0.1:${PORT}/api/projects/other`, { method: 'DELETE' })

  // ── the code pane: what it lists and what it refuses ─────────────────────
  // After the rename, not before it. The binary fixture below lands in a directory vite
  // is watching, and tearing the server down while it is still handling that add makes
  // vite log an ERR_CLOSED_SERVER stack to the journal — measured: adding this one write
  // to the suite as it stood before the code pane reproduced it twice. Here the browser
  // smoke runs in between, so vite has settled long before the DELETE kills it.
  const file = (path: string) =>
    fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/file?path=${encodeURIComponent(path)}`)

  const listing = (await (
    await fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/files`)
  ).json()) as { files?: string[] }
  check(listing.files?.includes('src/Home.tsx') === true, 'GET /files lists src/Home.tsx')
  check(listing.files?.includes('package.json') === true, 'GET /files lists package.json')
  check(
    !listing.files?.some((f) => f.startsWith('node_modules/') || f.startsWith('.git/')),
    'GET /files skips node_modules and .git',
  )

  // The HMR check above rewrote this file. Reading the edit back is what proves the
  // endpoint serves the working tree rather than anything it decided to remember.
  const shown = (await (await file('src/Home.tsx')).json()) as { content?: string; size?: number }
  check(shown.content?.includes('Edited app') === true, 'GET /file returns the file as it is on disk')
  check(
    shown.size === new TextEncoder().encode(shown.content ?? '').length,
    'GET /file reports the byte length it actually sent',
  )

  const outside = await file('../../../etc/passwd')
  check(outside.status === 400, `GET /file outside the project -> ${outside.status}`)
  // What the API serves and what the tree lists have to be the same set, or the pane
  // can open something it was never given a way to show.
  const hidden = await file('node_modules/vite/package.json')
  check(hidden.status === 400, `GET /file inside node_modules -> ${hidden.status}`)
  const missing = await file('src/Nope.tsx')
  check(missing.status === 404, `GET /file on a missing path -> ${missing.status}`)

  // A PNG decoded as UTF-8 is a pane full of replacement characters. It must say so instead.
  await Bun.write(join(PROJECTS, 'renamed-app', 'public', 'blob.bin'), new Uint8Array([0x89, 0x50, 0x00, 0x01]))
  const binary = (await (await file('public/blob.bin')).json()) as { binary?: boolean; content?: string }
  check(binary.binary === true && binary.content === undefined, 'GET /file marks a binary file binary')



  // ── PUT /file: the three guards ──────────────────────────────────────────
  const put = (body: unknown) =>
    fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const opened = (await (await file('src/Home.tsx')).json()) as { content?: string; token?: string }
  check(typeof opened.token === 'string', 'GET /file hands out a concurrency token')

  const edited = `${opened.content}\n// edited by hand\n`
  const saved = await put({ path: 'src/Home.tsx', content: edited, token: opened.token })
  check(saved.status === 200, `PUT with the right token -> ${saved.status}`)
  const reread = (await (await file('src/Home.tsx')).json()) as { content?: string; token?: string }
  check(reread.content === edited, 'the edit is on disk')
  check(reread.token !== opened.token, 'and the token moved with it')

  // The whole point of the token: a save from a buffer opened before someone else wrote.
  const clobber = await put({ path: 'src/Home.tsx', content: 'clobbered', token: opened.token })
  check(clobber.status === 409, `PUT with a stale token -> ${clobber.status}`)
  check(
    ((await (await file('src/Home.tsx')).json()) as { content?: string }).content === edited,
    'and the stale save changed nothing',
  )

  check((await put({ path: 'src/Nope.tsx', content: 'x', token: 'x' })).status === 404, 'PUT to a missing file -> 404')
  check(
    (await put({ path: '../../../tmp/escape', content: 'x', token: 'x' })).status === 400,
    'PUT outside the project -> 400',
  )
  check(
    (await put({ path: 'node_modules/vite/package.json', content: 'x', token: 'x' })).status === 400,
    'PUT into node_modules -> 400',
  )
  check((await put({ path: 'src/Home.tsx' })).status === 400, 'PUT without content -> 400')

  // A hand edit is revertible exactly like a turn, which is why this waited for commits.
  const lastCommit = await git(['log', '-1', '--format=%s'], 'renamed-app')
  check(lastCommit === 'edit: src/Home.tsx', `the edit was checkpointed -> "${lastCommit}"`)

  // ── check_app: what the agent sees of the app it wrote ───────────────────
  // Called in-process against the live vite, no model: every branch of the report is
  // asserted on a planted fault. The crash is the one the design log diagnosed on dev — a
  // render-time TypeError leaves #root empty and vite shows no overlay, so before this
  // tool the agent saw nothing and reported success.
  const appDir = join(PROJECTS, 'renamed-app')
  const appPort = ((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as {
    slug: string
    port?: number
  }[]).find((p) => p.slug === 'renamed-app')?.port
  const appBase = appPort ? `http://127.0.0.1:${appPort}` : undefined
  const homeSrc = await Bun.file(join(appDir, 'src/Home.tsx')).text()

  const clean = await checkApp(appDir, appBase)
  check(clean.includes('typecheck: clean') && clean.includes('no errors'), 'check_app: a clean app is clean')
  check(clean.includes('heading "Edited app"'), 'check_app: and the outline shows what rendered')
  for (const v of ['tablet', 'mobile'] as const) {
    check((await checkApp(appDir, appBase, '/', v)).includes('no errors'), `check_app: the scaffold is clean at ${v} too`)
  }

  await Bun.write(
    join(appDir, 'src/Home.tsx'),
    `const DIGITS: Record<string, string[]> = { '1': ['x'] }\n` +
      `export default function Home() {\n  return <h1>{DIGITS['23']!.map((d) => d)}</h1>\n}\n`,
  )
  const crashed = await checkApp(appDir, appBase)
  check(crashed.includes('APP CRASHED'), 'check_app: a render crash says APP CRASHED')
  check(crashed.includes("reading 'map'"), 'check_app: with the TypeError that caused it')

  await Bun.write(join(appDir, 'src/Home.tsx'), 'export default function Home() {\n  return <h1>\n}\n')
  const broken = await checkApp(appDir, appBase)
  check(broken.includes('COMPILE ERROR'), 'check_app: a syntax error shows the vite overlay')
  check(!broken.includes('typecheck: clean'), 'check_app: and fails the typecheck')

  const stopped = await checkApp(appDir, undefined)
  check(stopped.includes('preview: not running'), 'check_app: with no preview to reach, the browser half is said to be skipped')
  check((await checkApp(appDir, appBase, 'http://evil')).startsWith('path must start'), 'check_app: path must be a route')

  // A page that is noisy and reaches off its own origin. Both used to arrive in the same
  // `errors:` block, uncapped: measured 2026-09-23, 303 entries and 33 KB in one report,
  // with the blocked requests appearing as `net::ERR_BLOCKED_BY_CLIENT` and no URL — so
  // the model was told to go and fix something it could neither name nor reach. The cap
  // then kept the first ten, which hid the one line that mattered — the exception a step
  // raised after the noise — and a URL carrying state in its query was printed whole.
  await Bun.write(
    join(appDir, 'src/Home.tsx'),
    'export default function Home() {\n' +
      '  for (let i = 0; i < 40; i++) console.error("noise " + i)\n' +
      '  for (let i = 0; i < 40; i++) console.error("again")\n' +
      '  fetch("https://example.invalid/feed.xml").catch(() => {})\n' +
      '  return (\n' +
      '    <div>\n' +
      '      <h1>Noisy</h1>\n' +
      '      <img src={"https://example.invalid/hero.png?state=" + "x".repeat(5000)} alt="hero" />\n' +
      '      <button onClick={() => { throw new Error("thrown by the click") }}>Boom</button>\n' +
      '    </div>\n' +
      '  )\n' +
      '}\n',
  )
  const noisy = await checkApp(appDir, appBase, '/', 'desktop', [{ do: 'click', target: 'button "Boom"' }])
  check(noisy.includes('example.invalid/hero.png'), 'check_app: a blocked request is named, with its URL')
  check(!noisy.includes('x'.repeat(300)), 'check_app: but not a URL\'s whole query')
  check(noisy.includes('are not bugs to fix'), 'check_app: and marked as not a bug')
  // A fetch() is the other kind: it fails for the user too, and the report says so.
  const [assets = '', reads = ''] = noisy.split('DIRECT FETCH')
  check(reads.includes('example.invalid/feed.xml') && reads.includes('/_ab/fetch'), 'check_app: a direct fetch is DIRECT FETCH, with the relay to use')
  check(!assets.includes('feed.xml'), 'check_app: and is not listed with the images as harmless')
  check(!noisy.includes('ERR_BLOCKED_BY_CLIENT'), 'check_app: the blockers leave the error list')
  check(noisy.includes('thrown by the click'), 'check_app: an exception after the noise is still shown')
  check(/- again \(×\d+\)/.test(noisy), 'check_app: a repeated error is one line with its count')
  check((noisy.match(/- noise /g) ?? []).length <= 10, 'check_app: the error list is capped')
  check(noisy.includes('more console errors, not shown'), 'check_app: and says how many it did not print')
  check(noisy.length < 6000, 'check_app: so one noisy page cannot fill the turn')

  // Steps and viewports. The click's render is deferred 250 ms on purpose: an aria
  // snapshot does not auto-wait, and a report read straight after the click would say 0.
  await Bun.write(
    join(appDir, 'src/Home.tsx'),
    `import { useState } from 'react'\n` +
      `export default function Home() {\n` +
      `  const [n, setN] = useState(0)\n` +
      `  const [name, setName] = useState('')\n` +
      `  return (\n    <main>\n` +
      `      <p>Count: {n}</p>\n` +
      `      <button onClick={() => setTimeout(() => setN(n + 1), 250)}>Increment</button>\n` +
      `      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />\n` +
      `      <div style={{ width: 600 }}>banner</div>\n` +
      `    </main>\n  )\n}\n`,
  )
  const used = await checkApp(appDir, appBase, '/', 'desktop', [
    { do: 'click', target: 'button "Increment"' },
    { do: 'wait', target: 'paragraph "Count: 1"' },
    { do: 'fill', target: 'textbox "Name"', value: 'Ada' },
  ])
  check(used.includes('3. fill textbox "Name" "Ada" — ok'), 'check_app: steps run and are logged')
  check(used.includes('Count: 1') && used.includes('textbox "Name": Ada'), 'check_app: the outline is read after the steps')
  check(used.includes('no errors'), 'check_app: 600px fits a desktop')

  const phone = await checkApp(appDir, appBase, '/', 'mobile')
  check(phone.includes('at mobile 390×844'), 'check_app: mobile is 390 wide, as the preview pane')
  check(phone.includes('HORIZONTAL SCROLL') && phone.includes('600px wide'), 'check_app: and a 600px block overflows it, named')

  const missed = await checkApp(appDir, appBase, '/', 'desktop', [
    { do: 'click', target: 'button "Nope"' },
    { do: 'click', target: 'button "Increment"' },
  ])
  check(missed.includes('FAILED: nothing on the page matches button "Nope"'), 'check_app: a missing target fails its step')
  check(missed.includes('1 later step(s) not run') && !missed.includes('no errors'), 'check_app: stops there and is not clean')

  // look: the picture goes to whatever answers it — a stub here, the model in a turn.
  let seen: { jpeg: Uint8Array; question: string } | undefined
  const looked = await checkApp(appDir, appBase, '/', 'mobile', [], {
    question: 'Is the banner readable?',
    see: async (jpeg, question) => {
      seen = { jpeg, question }
      return 'The banner is cut off on the right.'
    },
  })
  check(seen?.jpeg[0] === 0xff && seen.jpeg[1] === 0xd8 && seen.jpeg.length > 1000, `check_app look: a JPEG reaches the seer (${seen?.jpeg.length ?? 0} bytes)`)
  check(seen?.question === 'Is the banner readable?', 'check_app look: with the question')
  check(looked.endsWith('look: Is the banner readable?\nThe banner is cut off on the right.'), 'check_app look: the answer ends the report')
  const blind = await checkApp(appDir, appBase, '/', 'desktop', [], {
    question: 'q',
    see: () => Promise.reject(new Error('model has no image input')),
  })
  check(blind.includes('could not look (model has no image input)'), 'check_app look: a failed look is said, not thrown')

  // The opposite fault, as a feed reader's first run had it (2026-09-26): a full-width
  // sticky header over a 448px card centred in grey. Right on a phone; on a desktop, a
  // phone layout. It renders inside the scaffold's AppShell, so neither the sidebar nor
  // the header spanning the room beside it may be what excuses the card.
  await Bun.write(
    join(appDir, 'src/Home.tsx'),
    `export default function Home() {\n` +
      `  return (\n    <div style={{ minHeight: '100dvh', background: '#f5f5f4' }}>\n` +
      `      <header style={{ position: 'sticky', top: 0, display: 'flex', justifyContent: 'space-between', padding: 16 }}>\n` +
      `        <b>Fold</b><button>Refresh</button>\n      </header>\n` +
      `      <div className="card" style={{ maxWidth: 448, margin: '120px auto', padding: 32, background: 'white' }}>\n` +
      `        <h2>Welcome to Fold</h2><p>Paste a feed address.</p><input aria-label="Feed" style={{ width: '100%' }} />\n` +
      `      </div>\n    </div>\n  )\n}\n`,
  )
  const lone = await checkApp(appDir, appBase, '/', 'desktop')
  check(
    /NARROW: the content spans 384px of the \d+px beside the navigation/.test(lone),
    'check_app: a lone card on a desktop is NARROW, measured beside the sidebar and inside the header',
  )
  check(lone.includes('class="card"') && !lone.includes('no errors'), 'check_app: naming the box that holds it, and not clean')
  const loneOnPhone = await checkApp(appDir, appBase, '/', 'mobile')
  check(!loneOnPhone.includes('NARROW') && loneOnPhone.includes('no errors'), 'check_app: the same card is right on a phone')

  await Bun.write(join(appDir, 'src/Home.tsx'), homeSrc)

  // ── edits the model did not make ─────────────────────────────────────────
  // This project has had no turn, so "last seen" is the scaffold, and the PUT above is an
  // edit the model has never heard of. A turn would rewrite Home.tsx from memory over it.
  const handNote = await noteOutsideEdits(appDir)
  check(handNote?.includes('M\tsrc/Home.tsx') === true, 'outside edits: a code-pane save is noted')
  check(handNote?.includes('+// edited by hand') === true, 'outside edits: with its diff')
  check(!handNote?.includes('.apps-builder'), 'outside edits: our own metadata is not the model\'s business')

  await Bun.write(join(appDir, 'src/Extra.tsx'), 'export const extra = 1\n')
  const diskNote = await noteOutsideEdits(appDir)
  check(diskNote?.includes('A\tsrc/Extra.tsx') === true, 'outside edits: a file written on disk is noted')
  check(
    (await git(['log', '-1', '--format=%s'], 'renamed-app')) === 'edit: outside the chat',
    'outside edits: and committed first, so it can be undone',
  )

  const turn = Bun.spawn(
    ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'turn 1: x'],
    { cwd: appDir },
  )
  await turn.exited
  check((await noteOutsideEdits(appDir)) === null, 'outside edits: nothing since the last turn, no note')

  // Mid-turn: the turn wrote Own.tsx; someone else wrote Theirs.tsx in a directory of its
  // own while it ran. The turn's commit takes only its files, the other is its own edit,
  // after it — so the next turn is told about Theirs and not about Own.
  await Bun.write(join(appDir, 'src/Own.tsx'), 'export const own = 1\n')
  await Bun.write(join(appDir, 'src/theirs/Theirs.tsx'), 'export const theirs = 1\n')
  await checkpoint(appDir, 'turn 2: y', (p) => p === 'src/Own.tsx')
  await checkpoint(appDir, 'edit: outside the chat (during turn 2)')
  const files = (ref: string) => git(['show', '--name-only', '--format=', ref], 'renamed-app')
  check((await git(['log', '-1', '--format=%s', 'HEAD~1'], 'renamed-app')) === 'turn 2: y', 'mid-turn: the turn is committed first')
  check((await files('HEAD~1')) === 'src/Own.tsx', 'mid-turn: with only its own file')
  check((await files('HEAD')) === 'src/theirs/Theirs.tsx', 'mid-turn: the other edit is a commit of its own, after it')
  const midNote = await noteOutsideEdits(appDir)
  check(
    midNote?.includes('A\tsrc/theirs/Theirs.tsx') === true && !midNote.includes('Own.tsx'),
    'mid-turn: the next turn is told about theirs, not its own',
  )

  // Real browser, real click. tsc and the API checks above are all blind to a render crash.
  // The API serves dist/client, so this tests a build and not the working tree — which is
  // why `bun run check` builds first. The staleness check that used to guard this was a
  // skip that could only ever skip, i.e. exactly the shape it was written to replace.
  //
  // The project it opens carries the GLM turn from above as its history, so the smoke can
  // open a reloaded turn's reasoning the way a person would.
  await Bun.write(join(PROJECTS, 'renamed-app', '.apps-builder', 'chat.json'), JSON.stringify(GLM_CHAT, null, 2))
  // And a spec, for the Artefacts pane to draw. Before it, none is null, not a 404: the
  // pane's empty state is an answer, not an error.
  const noSpec = await fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/artefacts`).then((r) => r.json())
  check(
    JSON.stringify(noSpec) === '{"spec":null,"plan":null,"design":null,"examples":null}',
    `artefacts: a project that has saved none answers nulls (${JSON.stringify(noSpec)})`,
  )
  await Bun.write(
    join(PROJECTS, 'renamed-app', '.apps-builder', 'plan.json'),
    JSON.stringify({
      steps: [
        { title: 'Today list', contract: 'Habits for today, tickable.', status: 'done' },
        { title: 'History grid', contract: 'A month of ticks per habit.', status: 'doing' },
      ],
    }),
  )
  // No `layouts`, on purpose: a spec saved before they existed must still open.
  await Bun.write(
    join(PROJECTS, 'renamed-app', '.apps-builder', 'spec.json'),
    JSON.stringify({
      summary: 'A habit tracker for one person.',
      personas: [{ name: 'Busy parent', goal: 'Tick off the day in seconds.' }],
      design: 'One column, big tap targets.',
      screens: [{ name: 'Today', purpose: 'tick habits off' }],
      edgeCases: ['No habits yet'],
    }),
  )
  // And a design brief, between the two, with the catalog design it names.
  await Bun.write(
    join(PROJECTS, 'renamed-app', '.apps-builder', 'design.json'),
    JSON.stringify({
      brief: {
        answer: '',
        picks: { Mood: 'Warm & friendly', Theme: 'Light', Density: 'Balanced', Inspiration: 'Airbnb' },
        inspiration: 'airbnb',
      },
    }),
  )
  const withBrief = (await fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/artefacts`).then((r) => r.json())) as {
    design?: { inspiration?: { name?: string; swatches?: string[] } }
  }
  check(
    withBrief.design?.inspiration?.name === 'Airbnb' && withBrief.design.inspiration.swatches?.length === 5,
    `artefacts: the design brief comes with the catalog design it names -> ${withBrief.design?.inspiration?.name}`,
  )
  // The design examples' routes, on a project with Propose design on and two examples passed:
  // the good page, as the check saw it (test/design.test.ts checks the check itself).
  const good = await checkDesign(GOOD, lit)
  const pickSlug = ((await post(`http://127.0.0.1:${PORT}/api/projects`, { name: 'Design Pick', settings: { design: true } })) as { slug: string }).slug
  const pickDir = join(PROJECTS, pickSlug)
  const shelf = join(pickDir, '.apps-builder', 'designs')
  for (const id of ['A', 'B']) {
    await Bun.write(join(shelf, `${id}.html`), id === 'A' ? GOOD : repaint('#ffffff', '#1b61c9'))
    await Bun.write(join(shelf, `${id}-desktop.jpg`), good.shots.desktop!)
    await Bun.write(join(shelf, `${id}-phone.jpg`), good.shots.phone!)
  }
  await writeDesign(pickDir, {
    brief: briefL,
    examples: [
      { id: 'A', from: 'claude', status: 'passed', tries: 1, name: 'Warm receipt', tokens: good.tokens, measured: good.measured, at: '2026-09-27T20:00:00.000Z' },
      { id: 'B', from: 'notion', status: 'passed', tries: 2, name: 'Clean ledger', tokens: { ...good.tokens, '--color-canvas': '#ffffff' }, at: '2026-09-27T20:01:00.000Z' },
      { id: 'C', from: 'stripe', status: 'dropped', tries: 3, reasons: ['it has a <script>: examples are shown with scripts off'] },
    ],
  })
  const pickBase = `http://127.0.0.1:${PORT}/api/projects/${pickSlug}`
  const pickView = (await fetch(`${pickBase}/artefacts`).then((r) => r.json())) as { examples?: DesignView | null }
  check(
    pickView.examples?.phase === 'pick' && pickView.examples.examples.map((e) => `${e.id}:${e.status}`).join() === 'A:passed,B:passed,C:dropped' &&
      pickView.examples.examples[0]?.fromName === 'Claude',
    `designs: /artefacts says the examples wait for a pick, with each one's design -> ${pickView.examples?.phase}`,
  )
  const served = await fetch(`${pickBase}/designs/A`)
  check(
    served.status === 200 && served.headers.get('content-security-policy') === CSP && !!served.headers.get('content-type')?.startsWith('text/html') &&
      served.headers.get('x-content-type-options') === 'nosniff' && (await served.text()).includes('Tip Splitter'),
    `designs: an example is served sandboxed, under the CSP the check rendered it with -> ${served.status} ${served.headers.get('content-security-policy')?.slice(0, 30)}`,
  )
  const absent = await Promise.all([`${pickBase}/designs/C`, `${pickBase}/designs/D`, `${pickBase}/designs/A/other.jpg`].map((u) => fetch(u).then((r) => r.status)))
  const picture = await fetch(`${pickBase}/designs/A/desktop.jpg?v=1`)
  check(
    absent.join() === '404,404,404' && picture.status === 200 && picture.headers.get('content-type') === 'image/jpeg',
    `designs: a dropped example, an unknown one and an unknown picture are 404s; a picture is a JPEG -> ${absent.join()} ${picture.status}`,
  )

  // The picker, as a person meets it: the chat's card, then View opens it full size in Artefacts.
  const chrome = chromePath()
  if (!chrome) console.log('  skip  design picker in the browser — no chromium')
  else {
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      // The origin header on this origin only, never browser-wide (the design log, *extraHTTPHeaders*).
      await ctx.route(`http://127.0.0.1:${PORT}/**`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-ab-origin': ORIGIN } }))
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.locator(`li button[aria-label="open ${pickSlug}"]`).click()
      const card = page.locator('section[aria-label="design examples"]')
      await card.waitFor({ timeout: 10_000 })
      const cards = await card.locator('li').count()
      const dropLine = await card.getByText('C (from Stripe) did not pass its check').count()
      const drawn = await card.locator('img').evaluateAll((els) => els.length > 0 && els.every((e) => (e as HTMLImageElement).naturalWidth > 0))
      await card.getByRole('button', { name: 'View', exact: true }).nth(1).click()
      const frame = page.locator('iframe[title^="design B"]')
      await frame.waitFor({ timeout: 10_000 })
      const sandboxed = await frame.getAttribute('sandbox')
      const heading = await page.frameLocator('iframe[title^="design B"]').locator('h1').textContent({ timeout: 10_000 })
      check(
        cards === 2 && dropLine === 1 && drawn && sandboxed === '' && heading === 'Tip Splitter',
        `browser: the chat's picker shows the two that passed and why C did not; View opens B, sandboxed, in Artefacts -> ${cards} cards, ${dropLine} line, pictures ${drawn}, sandbox "${sandboxed}", "${heading}"`,
      )
    } catch (e) {
      check(false, `browser: the design picker -> ${(e as Error).message.split('\n')[0]}`)
    } finally {
      await browser.close()
    }
  }

  // The pick: only an example that passed, null only when none did, once.
  const pickAs = (body: unknown) =>
    fetch(`${pickBase}/designs/pick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const wrongPicks = [(await pickAs({ id: 'C' })).status, (await pickAs({ id: null })).status, (await pickAs({})).status]
  const pickedA = (await (await pickAs({ id: 'A' })).json()) as DesignView
  const pickedTwice = (await pickAs({ id: 'B' })).status
  check(
    wrongPicks.join() === '400,400,400' && pickedA.phase === 'draft' && pickedA.picked === 'A' && pickedA.doc?.example === 'A' && pickedTwice === 409,
    `designs: the pick takes an example that passed, once, and DESIGN.md is next -> ${wrongPicks.join()} then ${pickedA.phase}:${pickedA.picked}, then ${pickedTwice}`,
  )
  // Back to the examples, and the pick again; Approve only once DESIGN.md is written.
  const designPost = (what: string) => fetch(`${pickBase}/designs/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const tooSoon = (await designPost('approve')).status
  const backed = (await (await designPost('unpick')).json()) as DesignView
  const backedTwice = (await designPost('unpick')).status
  const repicked = (await (await pickAs({ id: 'A' })).json()) as DesignView
  check(
    tooSoon === 409 && backed.phase === 'pick' && backed.picked === undefined && backed.doc === null && backedTwice === 409 && repicked.phase === 'draft',
    `designs: Back to the examples undoes the pick, and Approve waits for DESIGN.md -> ${tooSoon}, ${backed.phase}, ${backedTwice}, ${repicked.phase}`,
  )
  const draftState = await readDesign(pickDir)
  const pickGate2 = gateFor(designPhase(true, false, draftState), draftState, 'Design Pick')
  check(
    (await takeDoc(pickDir, pickGate2, SECTIONS)).startsWith('DESIGN.md saved'),
    'designs: DESIGN.md saved, as save_design_md saves it',
  )
  const mdServed = await fetch(`${pickBase}/design.md`)
  const mdText = await mdServed.text()
  const mdView = (await fetch(`${pickBase}/artefacts`).then((r) => r.json())) as { examples?: DesignView | null }
  check(
    mdServed.status === 200 && !!mdServed.headers.get('content-type')?.startsWith('text/plain') && mdText.startsWith('---\nversion: alpha\nname: Design Pick') &&
      mdView.examples?.phase === 'approve' && mdView.examples.doc?.front.colors.primary === '#cc785c' && mdView.examples.doc.sections?.overview === SECTIONS.overview,
    `designs: DESIGN.md is served as text, and /artefacts carries it, waiting for approval -> ${mdServed.status} ${mdView.examples?.phase}`,
  )
  const reader = tools(pickSlug, pickDir, { design: pickGate2 }).read_file
  const readAs = (path: string) =>
    Promise.resolve()
      .then(() => reader.execute!({ path }, { toolCallId: 'r', messages: [] } as never))
      .then(String, (e: Error) => `refused: ${e.message}`)
  const [readA = '', readMd = '', readJsonFile = ''] = await Promise.all(['.apps-builder/designs/A.html', '.apps-builder/DESIGN.md', '.apps-builder/design.json'].map(readAs))
  check(
    readA.includes('--color-canvas') && readMd.startsWith('---\nversion: alpha') && readJsonFile.startsWith('refused'),
    `designs: read_file reads the examples and DESIGN.md, and still nothing else under .apps-builder -> ${readJsonFile.slice(0, 50)}`,
  )

  // DESIGN.md as a person meets it: the chat's card, Read it opens it in Artefacts, and Back to
  // the examples brings the picker back.
  if (!chrome) console.log('  skip  DESIGN.md in the browser — no chromium')
  else {
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await ctx.route(`http://127.0.0.1:${PORT}/**`, (r) => r.continue({ headers: { ...r.request().headers(), 'x-ab-origin': ORIGIN } }))
      const page = await ctx.newPage()
      await page.goto(`http://127.0.0.1:${PORT}/`)
      await page.locator(`li button[aria-label="open ${pickSlug}"]`).click()
      const mdCard = page.locator('#ab-chat section[aria-label="DESIGN.md"]')
      await mdCard.waitFor({ timeout: 10_000 })
      const cardHead = await mdCard.locator('h2').textContent()
      const cardLine = await mdCard.getByText(SECTIONS.description).count()
      await mdCard.getByRole('button', { name: 'Read it', exact: true }).click()
      const mdPane = page.locator('#ab-preview section[aria-label="DESIGN.md"]')
      await mdPane.waitFor({ timeout: 10_000 })
      const status = await mdPane.getByText('waiting for your approval').count()
      const swatch = await mdPane.getByText('#cc785c', { exact: true }).count()
      const parts = await mdPane.getByText('button-primary', { exact: true }).count()
      const prose = await mdPane.getByText(SECTIONS.elevation).count()
      // The prose's {colors.primary} is drawn as the colour and its name, never as braces.
      const braces = await mdPane.getByText('{colors.primary}').count()
      await mdPane.locator('summary').click()
      await mdPane.locator('pre').filter({ hasText: 'version: alpha' }).waitFor({ timeout: 10_000 })
      await mdCard.getByRole('button', { name: 'Back to the examples', exact: true }).click()
      await page.locator('section[aria-label="design examples"]').waitFor({ timeout: 10_000 })
      check(
        cardHead === 'DESIGN.md is ready' && cardLine === 1 && status === 1 && swatch >= 1 && parts === 1 && prose === 1 && braces === 0,
        `browser: DESIGN.md's card in the chat, Read it opens it in Artefacts with its tokens, parts and prose; Back to the examples brings the picker -> "${cardHead}", ${status}, ${swatch}, ${parts}, ${prose}, braces ${braces}`,
      )
    } catch (e) {
      check(false, `browser: DESIGN.md -> ${(e as Error).message.split('\n')[0]}`)
    } finally {
      await browser.close()
    }
  }

  // The approval: code writes the design into the app and commits it as a design commit, which
  // leaves the project unbuilt; the next turn is told once what was applied.
  if ((await readDesign(pickDir))?.picked === undefined) await pickAs({ id: 'A' })
  const againState = await readDesign(pickDir)
  await takeDoc(pickDir, gateFor(designPhase(true, false, againState), againState, 'Design Pick'), SECTIONS)
  const cssBefore = await Bun.file(join(pickDir, 'src', 'app.css')).text()
  await Bun.write(join(pickDir, '.git', 'index.lock'), '')
  const unlocked = await designPost('approve')
  const afterFail = [await Bun.file(join(pickDir, 'src', 'app.css')).text(), (await readDesign(pickDir))?.doc?.approved]
  await rm(join(pickDir, '.git', 'index.lock'), { force: true })
  check(
    unlocked.status === 500 && afterFail[0] === cssBefore && afterFail[1] === undefined,
    `designs: an approval whose commit fails puts the files back and stays unapproved -> ${unlocked.status}, app.css kept ${afterFail[0] === cssBefore}`,
  )
  const approved = await designPost('approve')
  const approvedView = (await approved.json()) as DesignView
  const approvedTwice = (await designPost('approve')).status
  const [css = '', indexHtml = '', shell = ''] = await Promise.all(['src/app.css', 'index.html', 'src/AppShell.tsx'].map((f) => Bun.file(join(pickDir, f)).text()))
  const subject = (await new Response(Bun.spawn(['git', 'log', '-1', '--format=%s'], { cwd: pickDir, stdout: 'pipe' }).stdout).text()).trim()
  check(
    approved.status === 200 && approvedView.phase === 'done' && !!approvedView.doc?.approved && approvedTwice === 409 &&
      css.includes('@theme {\n  --color-canvas: #faf9f5;') && css.includes('  --default-font-family: var(--font-body);') && !css.includes('prefers-color-scheme') &&
      indexHtml.includes('family=Newsreader') && indexHtml.includes('<title>Design Pick</title>') && shell.includes("const APP_NAME = 'Design Pick'"),
    `designs: Approve writes the tokens into src/app.css, the fonts and the name into index.html and AppShell, once -> ${approved.status} ${approvedView.phase}, then ${approvedTwice}`,
  )
  check(
    subject === 'design: Warm receipt, from Claude' && (await listed(pickSlug))?.built === false && (await noteOutsideEdits(pickDir)) === null,
    `designs: and commits it as a design commit — still unbuilt, and no "changed outside the chat" -> ${subject}`,
  )
  const approvalGate = gateFor('done', await readDesign(pickDir), 'Design Pick')
  const approvalNote = await takeMessage(pickDir, [], 'Approve the design.', approvalGate)
  const approvalOnce = await takeMessage(pickDir, [], 'go on', gateFor('done', await readDesign(pickDir), 'Design Pick'))
  check(
    !!approvalNote?.startsWith('◆ DESIGN.md approved, and code applied it') && approvalNote.includes('bg-accent and text-accent') &&
      approvalNote.includes('Next: call save_spec again') && approvalNote.includes('read_file .apps-builder/DESIGN.md') && approvalOnce === null &&
      approvalGate.moved === true,
    `designs: the turn after is told once what code applied, and what to build with -> ${approvalNote?.split('\n')[0]?.slice(0, 60)}`,
  )
  // The frame in the design, in the project's own preview; the template's in its neutral look.
  if (chrome) {
    const ports = ((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as { slug: string; port?: number }[])
    const portOf = (slug: string) => ports.find((p) => p.slug === slug)?.port
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
    try {
      // Read once the page has settled: vite's first visit to a project optimises its
      // dependencies and reloads the page under whatever was reading it.
      const look = async (port: number | undefined) => {
        if (!port) return 'no preview'
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        let got = ''
        for (let i = 0; i < 3 && !got; i++) {
          got = await page
            .goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle', timeout: 30_000 })
            .then(() => page.locator('#root > div').first().waitFor({ timeout: 20_000 }))
            .then(() =>
              page.locator('#root > div').first().evaluate((el) => {
                const s = getComputedStyle(el)
                const mark = el.querySelector('nav span span') ?? el.querySelector('header span')
                return [s.backgroundColor, s.color, s.fontFamily.split(',')[0], mark ? getComputedStyle(mark).backgroundColor : ''].join(' | ')
              }),
            )
            .catch(() => '')
        }
        await page.close()
        return got || 'unreadable'
      }
      const designedLook = await look(portOf(pickSlug))
      const templateLook = await look(portOf('renamed-app'))
      check(
        designedLook === 'rgb(250, 249, 245) | rgb(20, 20, 19) | "DM Sans" | rgb(204, 120, 92)',
        `designs: the approved app's frame is in the design — canvas, ink, its font, primary on the mark -> ${designedLook}`,
      )
      check(
        templateLook === 'rgb(250, 250, 250) | rgb(23, 23, 23) | -apple-system | rgb(23, 23, 23)',
        `template: on tokens, the frame keeps Tailwind's neutral look -> ${templateLook}`,
      )
    } catch (e) {
      check(false, `browser: the approved app's frame -> ${(e as Error).message.split('\n')[0]}`)
    } finally {
      await browser.close()
    }
  }
  // Gone before the smoke, which opens the newest project and ends expecting none.
  await fetch(pickBase, { method: 'DELETE' })

  await smoke(`http://127.0.0.1:${PORT}/`, check, { 'x-ab-origin': ORIGIN }, PROJECTS)

  // ── the listing survives what it did not create ──────────────────────────
  // One directory the server did not make used to reject the whole Promise.all, so
  // GET /api/projects answered 400 and the landing screen went blank for every project.
  await Bun.write(join(PROJECTS, 'Not A Slug', 'package.json'), '{}')
  const withStray = await fetch(`http://127.0.0.1:${PORT}/api/projects`)
  check(withStray.ok, `a stray directory leaves the listing at ${withStray.status}`)
  check(
    ((await withStray.json()) as { slug: string }[]).every((p) => p.slug !== 'Not A Slug'),
    'and the stray is not listed as a project',
  )
  await rm(join(PROJECTS, 'Not A Slug'), { recursive: true, force: true })

  // slugify has to be its own fixed point, or safeSlug refuses the slug createProject
  // just derived: a name long enough to truncate on a separator was uncreatable.
  const longName = `${'a'.repeat(39)} b`
  const long = (await post(`http://127.0.0.1:${PORT}/api/projects`, { name: longName })) as { slug: string }
  check(long.slug === 'a'.repeat(39), `a 40-char-truncating name creates -> "${long.slug}"`)
  await fetch(`http://127.0.0.1:${PORT}/api/projects/${long.slug}`, { method: 'DELETE' })

  // A mistyped API path must be a 404, not the SPA shell with a 200 — src/api.ts parses
  // that body to null, types it as T, and the caller unmounts the tree dereferencing it.
  const typo = await fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app/histroy`)
  check(typo.status === 404, `a mistyped /api GET -> ${typo.status}`)
  check(
    (typo.headers.get('content-type') ?? '').includes('json'),
    'and it answers JSON, not index.html',
  )

  const renamedPod = await podOf('renamed-app')
  const del = await fetch(`http://127.0.0.1:${PORT}/api/projects/renamed-app`, { method: 'DELETE' })
  check(del.status === 204, `DELETE -> ${del.status}`)
  const podLeft = await Bun.spawn(['podman', 'pod', 'exists', renamedPod]).exited
  check(podLeft === 1, `and its pod is gone -> podman pod exists ${renamedPod}: ${podLeft}`)
  check(!(await Bun.file(join(PROJECTS, 'renamed-app', 'package.json')).exists()), 'project directory is gone')
  check(((await (await fetch(`http://127.0.0.1:${PORT}/api/projects`)).json()) as unknown[]).length === 0, 'project list is empty')
  const dead = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`, {
    headers: { host: 'renamed-app.preview.localhost' },
  })
  check(dead.status === 503, `its vite was killed -> dispatcher ${dead.status}`)
} catch (e) {
  console.error(e)
  failures++
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await Promise.resolve(fn()).catch(() => false)) return check(true, what)
    if (Date.now() > deadline) {
      check(false, `${what} (timed out after ${ms}ms)`)
      throw new Error(what)
    }
    await Bun.sleep(100)
  }
}

async function post(url: string, body: unknown): Promise<unknown> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status} ${await r.text()}`)
  return r.json()
}

