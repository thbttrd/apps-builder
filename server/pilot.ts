import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { type Browser, type Locator, type Page, chromium } from 'playwright-core'
import { AUDIT, offTokens } from './design-check'
import { chromePath } from './shots'

/**
 * The agent's eyes: load a running preview in headless chromium and say, in text, whether
 * it works. See the private design log *Browser pilot* for the perception order this follows —
 * compile overlay, then crash, then the aria tree. Pixels only when the model asks for a look,
 * and then as words: the screenshot goes to a describer (Seer), never to the model.
 *
 * playwright-core pinned to 1.63.0 because that is the release built against
 * chromium_headless_shell-1243, the one in ~/.cache/ms-playwright. The executable is
 * still passed explicitly: it never downloads anything.
 */

/** Past this the snapshot is a page of noise the model pays for on every later step. */
const SNAPSHOT_MAX = 4000
const TSC_MAX = 2000
/**
 * Every other section of the report has a ceiling; the number of errors did not. Measured
 * 2026-09-23: a page logging one console.error per render put 303 entries and 33 KB into a
 * single report — which is then persisted into chat.json and paid for, as cached prefix,
 * on every later turn of that project. Ten distinct lines at most, uncaught exceptions
 * held apart from console output so that no amount of logging can push out the crash.
 */
const THROWN_MAX = 4
const LOGGED_MAX = 6
/** Same reason. A page reaching for a CDN reaches for it in a loop as readily as once. */
const BLOCKED_MAX = 5
/** A URL is as long as the page makes it: one <img> with state in its query measured 8 KB. */
const URL_MAX = 200
/** the design log measured ~1 CPU of software rasterisation per page; two is the ceiling. */
const MAX_PAGES = 2

let browser: Promise<Browser> | undefined

/**
 * AB_BROWSER_CDP with its host name resolved to an address. Chrome answers its DevTools endpoint only to a
 * Host that is an IP address or localhost (a 500 otherwise), and on the cluster the browser is a pod of its
 * own behind a Service: its name is looked up at each connect.
 */
export async function cdpEndpoint(cdp: string): Promise<string> {
  const url = new URL(cdp)
  if (url.hostname !== 'localhost' && !isIP(url.hostname)) url.hostname = (await lookup(url.hostname, { family: 4 })).address
  return url.origin
}

/**
 * One chromium for the whole server, started on first use and again if it died. On the cluster it is
 * another's (AB_BROWSER_CDP: a container beside this one, or a pod of its own behind a
 * Service): the model's pages run there, away from this process's token, keys and projects, and this one
 * only drives it.
 */
export async function getBrowser(): Promise<Browser> {
  if (browser) {
    const b = await browser.catch(() => undefined)
    if (b?.isConnected()) return b
  }
  const cdp = Bun.env.AB_BROWSER_CDP
  if (cdp) {
    browser = cdpEndpoint(cdp).then((endpoint) => chromium.connectOverCDP(endpoint))
    return browser
  }
  const executablePath = chromePath()
  if (!executablePath) throw new Error('no chromium in ~/.cache/ms-playwright')
  browser = chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-gpu'] })
  return browser
}

let open = 0
const queue: (() => void)[] = []
export async function slot<T>(fn: () => Promise<T>): Promise<T> {
  // The slot is taken here, or handed straight over by the release below — never taken
  // again on waking. A waiter resumes a microtask after it is resolved, and a call
  // arriving in that gap saw the slot free and took it too: three contexts against a
  // ceiling of two, which is the one number this whole file exists to hold.
  if (open >= MAX_PAGES) await new Promise<void>((r) => queue.push(r))
  else open++
  try {
    return await fn()
  } finally {
    const next = queue.shift()
    if (next) next()
    else open--
  }
}

/** The preview pane's FORM_FACTORS (src/Workspace.tsx), plus the gallery shot's desktop. */
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
} as const
type Viewport = keyof typeof VIEWPORTS

/**
 * One thing to do to the page before it is reported on. `target` is written the way the
 * aria outline prints an element — `button "Add"`, `textbox "Email"` — so the model can
 * copy a line of one report into the next call; anything else is matched as visible text.
 */
export type Step = { do: 'click' | 'fill' | 'press' | 'wait'; target?: string; value?: string }

/**
 * Answers a question about a screenshot. Supplied by the caller — the agent loop owns the
 * model, the key and the turn's cost tally; this file only owns the browser.
 */
export type Seer = (jpeg: Uint8Array, question: string) => Promise<string>

/** Every wait inside a step. A step that needs longer is a bug to report, not wait out. */
const STEP_MS = 5000

/**
 * The text report `check_app` hands the model. `vite` undefined means the preview could not
 * be started — the typecheck still runs, and the browser half says it was skipped.
 */
export async function checkApp(
  dir: string,
  /** The preview's vite, e.g. http://127.0.0.1:41234 (previews.ts addressOf); undefined when it isn't running. */
  vite: string | undefined,
  path = '/',
  viewport: Viewport = 'desktop',
  steps: Step[] = [],
  look?: { question: string; see: Seer },
  /** An approved design's tokens (design-doc.ts themeOf): what the page paints off them is OFF-DESIGN. */
  design?: Record<string, string>,
): Promise<string> {
  if (!path.startsWith('/')) return `path must start with "/": ${path}`
  const [tsc, page] = await Promise.all([
    // Both halves degrade to a sentence rather than rejecting. Bun.spawn THROWS when the
    // executable is missing (verified 2026-09-23) — here that is node itself, so a box
    // without node, like the code-server container, failed the whole tool and discarded a
    // browser inspection that had succeeded. A missing tsc is not this case: node starts,
    // exits non-zero, and says so as the typecheck's output.
    typecheck(dir).catch((e: Error) => `could not be run (${e.message.split('\n')[0]})`),
    vite === undefined
      ? 'preview: not running, and it could not be started; nothing in the browser was checked'
      : slot(() => inspect(`${vite}${path}`, viewport, steps, look, design)).catch(
          (e: Error) => `preview: could not be checked (${e.message.split('\n')[0]})`,
        ),
  ])
  return `typecheck: ${tsc}\n${page}`
}

async function typecheck(dir: string): Promise<string> {
  const proc = Bun.spawn(
    ['node', join(dir, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false'],
    { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
  )
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
  return (await proc.exited) === 0 ? 'clean' : `\n${cap(out.trim(), TSC_MAX)}`
}

async function inspect(
  url: string,
  viewport: Viewport,
  steps: Step[],
  look?: { question: string; see: Seer },
  design?: Record<string, string>,
): Promise<string> {
  const origin = new URL(url).origin
  const context = await (await getBrowser()).newContext({ viewport: VIEWPORTS[viewport] })
  try {
    // The page is LLM-written code. It gets its own origin and nothing else: no the git server, no
    // metadata endpoint, no exfiltration by <img src>. Websockets (vite's HMR) are not
    // routed through here, and only go to the same origin anyway.
    //
    // What was turned away is kept, and reported under its own heading. Chromium logs a
    // blocked request as `Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector`
    // with no URL on it (measured 2026-09-23) — in the `errors:` block that is
    // indistinguishable from a bug in the app, and the system prompt tells the model to
    // fix what it finds there. Models reach for picsum, unsplash and Google Fonts
    // constantly, so this was a standing invitation to spend a turn chasing something it
    // could neither fix nor name.
    //
    // Except the app's own reads. An <img> or a font from another site does load for the
    // user; a fetch() of one mostly does not — CORS — and that is a real bug, with a real
    // fix in the same-origin relay (fetch-relay.mjs), which this browser can reach.
    const blocked = tally(BLOCKED_MAX, 'refused requests')
    const direct = tally(BLOCKED_MAX, 'direct reads')
    await context.route('**/*', (r) => {
      const u = r.request().url()
      if (new URL(u).origin === origin) return r.continue()
      const read = ['fetch', 'xhr', 'eventsource'].includes(r.request().resourceType())
      ;(read ? direct : blocked).add(cap(u, URL_MAX))
      return r.abort('blockedbyclient')
    })
    const page = await context.newPage()
    // Counted in full, held only as far as the report prints: a render loop logs on every
    // frame for as long as the load and the steps take.
    const thrown = tally(THROWN_MAX, 'uncaught exceptions')
    const logged = tally(LOGGED_MAX, 'console errors')
    // Only the app's own frames: React's are ~10 lines of node_modules per error, and
    // vite's ?t= cache-busters make every line longer without saying anything.
    page.on('pageerror', (e) =>
      thrown.add(
        cap(
          (e.stack ?? e.message)
            .split('\n')
            .filter((l) => !l.includes('/node_modules/'))
            .join('\n')
            .replace(/\?t=\d+/g, ''),
          600,
        ),
      ),
    )
    page.on('console', (m) => {
      // The blocked-request line goes under `blocked` instead, where it has its URL.
      if (m.type() === 'error' && !m.text().includes('ERR_BLOCKED_BY_CLIENT')) logged.add(cap(m.text(), 600))
    })

    const res = await page.goto(url, { waitUntil: 'load', timeout: 20_000 })
    // A cold vite compiles modules on first request; load fires before React has
    // rendered. networkidle ignores the HMR socket, so it does settle.
    await settle(page, 10_000)

    const { width, height } = VIEWPORTS[viewport]
    const lines = [`preview: ${url} at ${viewport} ${width}×${height} → HTTP ${res?.status() ?? '?'}`]

    // Run in order, stop at the first that fails: every later step assumed it worked.
    let failed = false
    if (steps.length) {
      const log: string[] = []
      for (const [i, step] of steps.entries()) {
        const what = `${i + 1}. ${step.do}${step.target ? ` ${step.target}` : ''}${step.value !== undefined ? ` ${JSON.stringify(step.value)}` : ''}`
        try {
          await perform(page, step)
          await settle(page, 2000)
          log.push(`${what} — ok`)
        } catch (e) {
          failed = true
          log.push(`${what} — FAILED: ${(e as Error).message.split('\n')[0]}`)
          if (i + 1 < steps.length) log.push(`(${steps.length - i - 1} later step(s) not run)`)
          break
        }
      }
      lines.push(`steps:\n${log.join('\n')}`)
    }

    // Vite overlays transform errors only (a bad import, a syntax error). Its shadow root
    // holds a stack trace; the first 400 characters say what and where.
    const overlay = await page
      .locator('vite-error-overlay')
      .evaluate((el) => el.shadowRoot?.textContent ?? '', undefined, { timeout: 500 })
      .catch(() => '')
    if (overlay) lines.push(`COMPILE ERROR (vite overlay):\n${cap(overlay.replace(/\s+/g, ' ').trim(), 400)}`)

    if (blocked.total) {
      lines.push(
        'blocked — the browser doing this check may only reach the preview origin. These ' +
          `were refused here, load normally for the user, and are not bugs to fix:\n${blocked.lines().join('\n')}`,
      )
    }
    if (direct.total) {
      lines.push(
        'DIRECT FETCH — the app read another site straight from the browser. Most sites refuse ' +
          `that for the user too (no CORS headers). Fetch through the preview's relay instead, ` +
          `fetch('/_ab/fetch?url=' + encodeURIComponent(url)), which this check can follow:\n` +
          direct.lines().join('\n'),
      )
    }
    // Exceptions first: they are what crashed, and the console is often only its echo.
    const errorCount = thrown.total + logged.total
    if (errorCount) lines.push(`errors:\n${[...thrown.lines(), ...logged.lines()].join('\n')}`)

    // A React render crash unmounts everything and vite shows no overlay: an empty root
    // is the only symptom. Say it in words — a screenshot of white says nothing.
    const empty = await page.evaluate(() => !document.getElementById('root')?.innerHTML.trim())
    if (empty && !overlay) lines.push('APP CRASHED: #root is empty — nothing rendered')

    // The system prompt's "no horizontal scroll" rule, measured. Names the innermost
    // elements that stick out, since the one to fix is rarely the page itself.
    const wide = await page.evaluate(overflow)
    if (wide) lines.push(wide)
    // And its opposite, the "three layouts" rule: a phone column centred in a wide window.
    const slim = wide ? '' : await page.evaluate(narrow)
    if (slim) lines.push(slim)
    // DESIGN.md's contract, held as the examples' check holds a page: once approved, the app's colours and
    // fonts are its @theme's. The examples' audit, on what this page drew (scripts and all: it is the app).
    const off = design && !empty && !overlay ? offTokens(await page.evaluate(AUDIT), design) : []
    if (off.length) {
      lines.push(
        "OFF-DESIGN — not the approved design's tokens (src/app.css @theme): use them, or change a token when the " +
          `person asked for a new look:\n${off.join('\n')}`,
      )
    }

    if (!empty && !overlay) {
      // body, never main: portals render outside it and the scaffold has no <main>.
      lines.push(`page:\n${cap(await page.locator('body').ariaSnapshot({ timeout: 5000 }), SNAPSHOT_MAX)}`)
    }
    if (!errorCount && !overlay && !empty && !wide && !slim && !off.length && !failed) {
      lines.push('no errors')
    }

    // Pixels last, and only when asked: the outline cannot see white-on-white, a covered
    // button or a clipped heading (the design log, *Browser pilot*: toBeVisible() passed on all
    // of them). The picture goes to a separate call and only its words come back, so the
    // loop's history stays text and its cached prefix stays cheap. The viewport, not the
    // full page: a tall page is a tall image, and the question is about what was changed.
    if (look) {
      const answer = empty
        ? 'nothing rendered, so there was nothing to look at'
        : await look
            .see(await page.screenshot({ type: 'jpeg', quality: 70 }), look.question)
            .catch((e: Error) => `could not look (${e.message.split('\n')[0]})`)
      lines.push(`look: ${look.question}\n${answer.trim()}`)
    }
    return lines.join('\n')
  } finally {
    await context.close().catch(() => {})
  }
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {})
}

async function perform(page: Page, step: Step): Promise<void> {
  if (step.do === 'press') {
    if (!step.value) throw new Error('press needs a key in value, e.g. "Enter"')
    if (step.target) await (await locate(page, step.target)).press(step.value, { timeout: STEP_MS })
    else await page.keyboard.press(step.value)
    return
  }
  if (step.do === 'wait' && !step.target) {
    await page.waitForTimeout(Math.min(Number(step.value) || 500, STEP_MS))
    return
  }
  if (!step.target) throw new Error(`${step.do} needs a target, e.g. button "Save"`)
  const el = await locate(page, step.target)
  if (step.do === 'click') await el.click({ timeout: STEP_MS })
  else if (step.do === 'fill') await el.fill(step.value ?? '', { timeout: STEP_MS })
  // wait: locate() has already waited for it to appear
}

/**
 * A step's target: `role "name"` as the outline writes it, or bare text. The outline is YAML, so a name's
 * quotes come escaped (`checkbox "Mark \"Learn React\" as done"`), which no element's name matches; a
 * target written with bare inner quotes is taken as it stands.
 */
export function targetOf(target: string): { role?: string; name: string } {
  const [, role, quoted] = /^([a-z]+) "(.*)"$/.exec(target.trim()) ?? []
  if (!role || quoted === undefined) return { name: target.trim() }
  try {
    return { role, name: JSON.parse(`"${quoted}"`) as string }
  } catch {
    return { role, name: quoted }
  }
}

/**
 * `role "name"` is a role locator; if nothing has that role and name it falls back to the
 * name as visible text — a paragraph's outline line is its text, but a paragraph has no
 * accessible name, so getByRole('paragraph', {name}) matches nothing (the design log, *Browser
 * pilot*). Waits for either to appear: a snapshot does not auto-wait and neither should
 * the model have to.
 */
async function locate(page: Page, target: string): Promise<Locator> {
  const { role: r, name } = targetOf(target)
  const text = page.getByText(name, { exact: true })
  const role = r && page.getByRole(r as Parameters<Page['getByRole']>[0], { name, exact: true })
  // Playwright's own message here is "waitFor: Timeout 5000ms exceeded", which does not
  // say what was missing; the model needs the target back to correct it.
  await (role ? role.or(text) : text)
    .first()
    .waitFor({ timeout: STEP_MS })
    .catch(() => {
      throw new Error(`nothing on the page matches ${target} after ${STEP_MS / 1000}s`)
    })
  return role && (await role.count()) ? role : text
}

/** Runs in the page. Returns a warning line, or '' when nothing sticks out. */
export function overflow(): string {
  const vw = document.documentElement.clientWidth
  const sw = document.documentElement.scrollWidth
  if (sw <= vw) return ''
  const out = [...document.body.querySelectorAll<HTMLElement>('*')].filter(
    (el) => el.getBoundingClientRect().right > vw + 1,
  )
  const innermost = out.filter((el) => !out.some((o) => o !== el && el.contains(o))).slice(0, 3)
  const name = (el: HTMLElement) =>
    `<${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? ` class="${el.className.slice(0, 80)}"` : ''}> ${Math.round(el.getBoundingClientRect().width)}px wide`
  return `HORIZONTAL SCROLL: the page is ${sw}px wide in a ${vw}px viewport. Sticking out:\n${innermost.map((el) => `- ${name(el)}`).join('\n')}`
}

/**
 * Runs in the page. Returns a warning line, or '' when the content uses the window.
 *
 * A phone layout centred in a desktop window passes every other check. Seen 2026-09-26: a
 * feed reader's first run was a 448px card in 1280px of grey, checked at desktop, "no
 * errors", done. Measured from the elements that carry content — text, images, controls —
 * by their boxes, so a centred line in a full-width block still counts as full width.
 * Navigation is the frame, not the page: what is in a <nav> is left out, and the page is
 * measured against the room beside a side nav, so a lone card next to AppShell's sidebar
 * is still a lone card. So are full-width bars, top bar and tab bar alike: they span any
 * layout, so what sits in them says nothing about the page. Tablet and desktop only.
 */
function narrow(): string {
  const vw = document.documentElement.clientWidth
  const vh = window.innerHeight
  if (vw < 768) return ''
  const box = (el: Element) => el.getBoundingClientRect()
  const sides = [...document.querySelectorAll('nav')].filter(
    (n) => !n.parentElement?.closest('nav') && box(n).width >= 2 && box(n).height >= vh / 2,
  )
  const room = vw - sides.reduce((w, n) => w + box(n).width, 0)
  const REPLACED = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'IFRAME'])
  const framed = new Map<Element, boolean>()
  const inFrame = (el: Element | null): boolean => {
    if (!el || el === document.body) return false
    let v = framed.get(el)
    if (v === undefined) {
      const r = box(el)
      const s = getComputedStyle(el)
      const edge = ['HEADER', 'FOOTER'].includes(el.tagName) || s.position === 'fixed' || s.position === 'sticky'
      v = el.tagName === 'NAV' || (edge && r.width >= room * 0.9 && r.height <= vh * 0.25) || inFrame(el.parentElement)
      framed.set(el, v)
    }
    return v
  }
  const content = [...document.body.querySelectorAll('*')].filter((el) => {
    if (!REPLACED.has(el.tagName.toUpperCase()) && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
      return false
    const r = box(el)
    return r.width >= 2 && r.height >= 2 && getComputedStyle(el).visibility !== 'hidden' && !inFrame(el)
  })
  if (!content.length) return ''
  const left = Math.max(0, Math.min(...content.map((el) => box(el).left)))
  const right = Math.min(vw, Math.max(...content.map((el) => box(el).right)))
  const span = Math.round(right - left)
  if (span >= room / 2) return ''
  // The innermost element holding all of it is usually the one whose max-w-* is the cause.
  let holder: Element = content[0]!
  while (holder.parentElement && !content.every((el) => holder.contains(el))) holder = holder.parentElement
  const cls = typeof holder.className === 'string' && holder.className ? ` class="${holder.className.slice(0, 80)}"` : ''
  const of = room < vw ? `the ${Math.round(room)}px beside the navigation` : `this ${vw}px window`
  return (
    `NARROW: the content spans ${span}px of ${of} (x ${Math.round(left)}–${Math.round(right)}), ` +
    `all inside <${holder.tagName.toLowerCase()}${cls}> — a phone layout with empty space around it. ` +
    'Lay this screen out for the width: columns or a grid, with empty and first-run states inside ' +
    'that layout. Widening the text is not the fix.'
  )
}

/**
 * Distinct lines and how often each came, holding at most `max`: the first half ever seen
 * and the latest of the rest. The first are usually the cause; the latest are what the
 * steps just did — ten warnings on load must not hide the exception a click raised after
 * them, and measured 2026-09-23 they did, when this kept the first ten. A repeat is
 * counted rather than kept, because a render loop says one thing three hundred times.
 */
function tally(max: number, what: string) {
  const seen = new Map<string, number>()
  let total = 0
  return {
    add(line: string) {
      total++
      const n = seen.get(line)
      if (n !== undefined) seen.set(line, n + 1)
      else {
        // Full: the oldest of the latest half goes; the first half is kept for good.
        if (seen.size >= max) seen.delete([...seen.keys()][max >> 1] as string)
        seen.set(line, 1)
      }
    },
    get total() {
      return total
    },
    /** Bullets in the order first seen, with the gap marked where the dropped ones were. */
    lines(): string[] {
      const out = [...seen].map(([l, n]) => `- ${l}${n > 1 ? ` (×${n})` : ''}`)
      const rest = total - [...seen.values()].reduce((a, n) => a + n, 0)
      if (rest > 0) out.splice(max >> 1, 0, `(${rest} more ${what}, not shown)`)
      return out
    },
  }
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s
}
