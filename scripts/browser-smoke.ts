/**
 * Loads the UI in real Chromium and clicks a project, asserting no console error.
 *
 * This exists because a white-page crash shipped once: a concise-body useEffect
 * returned scrollIntoView()'s Promise, React called it as cleanup, and the tree
 * unmounted. tsc was clean, every API check was green, and nothing else could see it.
 *
 * Skips only when this box has no chromium at all. A chromium that exists and then fails to
 * launch is a FAILURE — that is the shape that skipped silently for a fortnight while the one
 * guard against a white page never ran (see the libcups trap in the private design log). Leave a
 * sentence saying otherwise and the next reader re-authorises the skip.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright-core'
import { chromePath } from '../server/shots'

/** A dozen earlier exchanges, as GET /chat returns them: a history taller than the chat. */
const EARLIER = `Array.from({ length: 12 }, (_, i) => [
  { role: 'user', content: 'earlier ' + i },
  { role: 'assistant', content: 'an earlier reply,\\nover\\nfour lines\\nof it' },
]).flat()`

/**
 * Installed before the project opens, because that is when the chat reads GET /chat. The
 * check server runs without a key, so GET /chat is told one is set, or the composer stays
 * disabled, and answers the real history under EARLIER, so the chat has room to scroll;
 * POST /chat answers from a stream that the smoke feeds through `window.__say`, one SSE
 * frame per event, and ends with `window.__end`. POST /restore is answered here, as if it
 * worked, and GET /chat adds `window.__later` to the history, so the smoke can play a
 * code+chat restore without moving the project. OpenRouter's catalog is answered here too,
 * with the house model and every model a project is set to — the settings checks set one —
 * so More › Settings draws its knobs without the network, and
 * without the origin header, which setExtraHTTPHeaders would otherwise send there, where the
 * preflight it causes is refused. Everything else goes to the server.
 */
const STUB = `(() => {
  const real = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.endsWith('/restore')) return new Response('{}', { headers: { 'content-type': 'application/json' } })
    if (url.startsWith('https://openrouter.ai/')) {
      const set = (await (await real('/api/projects')).json()).map((p) => p.model)
      const data = [...new Set([window.__house, ...set])].filter(Boolean).map((id) => ({ id, context_length: 131072, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools', 'temperature'], default_parameters: { temperature: 1 } }))
      return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } })
    }
    if (!url.endsWith('/chat')) return real(input, init)
    if ((init?.method ?? 'GET') === 'POST') {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start: (c) => {
          window.__say = (e) => c.enqueue(encoder.encode('data: ' + JSON.stringify(e) + '\\n\\n'))
          window.__end = () => c.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    const r = await real(input, init)
    const d = await r.json()
    window.__house = d.defaultModel
    const messages = [...${EARLIER}, ...d.messages, ...(window.__later ?? [])]
    return new Response(JSON.stringify({ ...d, configured: true, messages }), { status: r.status, headers: { 'content-type': 'application/json' } })
  }
})()`

/**
 * What the restored history has where the stubbed turn was, which chat.json never got. A ✎
 * note first, as the stubbed turn had, so each of its rows lands where one of that turn's
 * was: without it, this reply took the place of the stubbed message, which has no panel to
 * hand on, and rows keyed by index passed.
 */
const LATER = [
  { role: 'user', content: '✎ These files were changed outside the chat:\nM\tsrc/Home.tsx' },
  { role: 'user', content: 'a later turn' },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'Later reasoning.' }, { type: 'text', text: 'Later.' }] },
]

/**
 * For after a reload, in place of STUB: a turn is running that this tab did not start. GET
 * /chat answers the real history under EARLIER, and says the turn is running, until
 * `window.__finish()`. The watcher's next poll then finds it done, one exchange longer.
 */
const WATCH = `(() => {
  const real = window.fetch.bind(window)
  let done = false
  window.__finish = () => { done = true }
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.endsWith('/chat') || (init?.method ?? 'GET') !== 'GET') return real(input, init)
    const d = await (await real(input, init)).json()
    const earlier = ${EARLIER}
    const turn = done ? [{ role: 'user', content: 'the watched turn' }, { role: 'assistant', content: 'Watched reply.' }] : []
    const messages = [...earlier, ...d.messages, ...turn]
    return new Response(JSON.stringify({ ...d, configured: true, running: !done, messages }), { headers: { 'content-type': 'application/json' } })
  }
})()`

/** A button's accessible name, near enough: its text without the parts hidden from it. */
const NAMED = `((b) => { const c = b.cloneNode(true); c.querySelectorAll('[aria-hidden]').forEach((n) => n.remove()); return c.textContent.trim() })`
/** What a button shows: its text without the screen-reader-only parts. */
const SEEN = `((b) => { const c = b.cloneNode(true); c.querySelectorAll('.sr-only').forEach((n) => n.remove()); return c.textContent.trim() })`

/** check-preview's: prints the sentence, and counts it when it fails. */
type Check = (ok: boolean, what: string) => void

/**
 * The smoke, asserting as it goes: each check is made where what it checks is read. At its
 * end, that no page error, console error or failed read happened anywhere in it. `projects` is
 * the server's projects directory: the first build's checks write a project's files there, as
 * a turn would.
 */
export async function smoke(url: string, check: Check, headers: Record<string, string>, projects: string): Promise<void> {
  const chrome = chromePath()
  if (!chrome || !(await Bun.file(chrome).exists())) {
    console.log('  skip  browser smoke — no chromium in ~/.cache/ms-playwright')
    return
  }
  // --disable-dev-shm-usage, as Playwright's own launches pass it: the container's /dev/shm
  // is 62.5 MiB, the watched-turn reload below takes this Chrome to about 55 MB of it, and
  // with any other Chrome running beside it the renderer ran out and died (3 runs in 3).
  let browser: Browser
  try {
    browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] })
  } catch (e) {
    // A failure, not a skip: the binary exists, so this box is meant to have browser
    // coverage and does not. Returning ok here is how the libcups-broken build printed
    // `skip` every run for a fortnight while nothing was ever checked.
    check(false, `browser: chromium launches (${(e as Error).message.split('\n')[0]})`)
    return
  }
  const errors: string[] = []
  try {
    await run(browser, url, check, headers, projects, errors)
  } catch (e) {
    errors.push((e as Error).message.split('\n')[0]!)
  } finally {
    await browser.close()
  }
  check(errors.length === 0, `browser: load + click a project, no console error${errors.length ? ` (${errors[0]})` : ''}`)
}

async function run(browser: Browser, url: string, check: Check, headers: Record<string, string>, projects: string, errors: string[]): Promise<void> {
  // 800x600: what headless Chrome gave the page when this was written against CDP, and what
  // every measurement below was taken at. Playwright's own default is 1280x720.
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } })
  // The origin header on this origin only, never browser-wide (the design log, *extraHTTPHeaders*).
  await ctx.route(`${new URL(url).origin}/**`, (r) => r.continue({ headers: { ...r.request().headers(), ...headers } }))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]!))
  // console.error calls, as the page makes them. Not Chrome's own lines about a resource that
  // failed to load, which the CDP version of this never listened for.
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text().split('\n')[0]!)
  })

  /**
   * An expression's value in the page, as a string, the way the checks compare it. One that
   * throws is an error of the smoke's: that is how a selector that stopped matching fails it,
   * rather than passing it and failing one line later under another check's name.
   */
  const read = (expression: string) =>
    page.evaluate(expression).then(
      (v) => (v === undefined || v === null ? '' : String(v)),
      (e: Error) => {
        errors.push(e.message.split('\n')[0]!)
        return ''
      },
    )
  /** Up to `ms` for an expression to come true, so a busy machine is waited for, not failed. */
  const until = async (expression: string, ms = 2000) => {
    for (const end = Date.now() + ms; Date.now() < end && (await read(expression)) !== 'true'; ) await Bun.sleep(50)
  }
  /**
   * Two frames: what is measured after a render has to wait for the browser's own work on it —
   * ResizeObservers, which mask the tail box and keep a panel pinned, run once per frame.
   */
  const frames = () => read('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))')
  /** A tap at the middle of an element, through the browser's input rather than click(). */
  const tap = async (element: string) => {
    const [x, y] = JSON.parse((await read(`JSON.stringify(((r) => [r.left + r.width / 2, r.top + r.height / 2])(${element}.getBoundingClientRect()))`)) || '[0, 0]') as [number, number]
    await page.mouse.click(x, y)
  }

  await page.goto(url)
  await read(STUB)

  // The projects screen's one field searches and creates, so a name that is taken must not
  // be creatable, and must say why where a screen reader hears it; so must one that makes no
  // slug. Typed through the native setter: React only hears an input event for a value it
  // did not set itself.
  const field = `document.querySelector('input[type="search"]')`
  await until(`!!${field} && !!document.querySelector('li button[aria-label^="open "]')`, 10_000)
  const type = (text: string) =>
    read(`((i) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })) })(${field})`)
  const hint = `((h) => [h.getAttribute('role'), h.textContent])(document.getElementById(${field}.getAttribute('aria-describedby')))`
  /** The hint's text, or '' while there is none. */
  const hinted = `(document.getElementById(${field}.getAttribute('aria-describedby') ?? '')?.textContent ?? '')`
  const refused = `JSON.stringify([${field}.form.querySelector('button').getAttribute('aria-disabled'), ...${hint}])`
  await type(' Renamed App ')
  await until(`${hinted} !== ''`)
  const taken = await read(refused)
  check(
    taken === JSON.stringify(['true', 'status', '“renamed-app” already exists.']),
    `browser: " Renamed App " is taken: Create is off and a status says so (${taken})`,
  )
  await type('!!!')
  await until(`${hinted} !== '' && !${hinted}.includes('already exists')`)
  const nameless = await read(refused)
  check(
    nameless === JSON.stringify(['true', 'status', 'A name needs a letter or a digit (a–z, 0–9).']),
    `browser: and "!!!" makes no name: Create is off and a status says so too (${nameless})`,
  )
  await type('')
  await until(`!${field}.hasAttribute('aria-describedby')`)

  // The start page's More, over the draft a new project is made with: opened from the page,
  // Propose design switched on in its Harness, closed, and read back from the line under the
  // box and from this browser's storage. Then back to the projects, where the rest starts.
  const labelled = (text: string) =>
    `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`
  await read(`${field}.form.querySelector('button').click()`)
  await until(`!!document.querySelector('textarea[aria-label="what to build"]')`)
  await read(`${labelled('More')}.click()`)
  await until(`!!document.querySelector('dialog[open] h2')`)
  const sheet = await read(`document.querySelector('dialog[open] h2').textContent`)
  check(sheet === 'More', `browser: the start page's More opens its sheet (${JSON.stringify(sheet)})`)
  await read(`${labelled('Harness')}.click()`)
  await until(`!!document.querySelector('dialog[open] input[role="switch"]')`)
  await read(`document.querySelector('dialog[open] input[role="switch"]').click()`)
  await until(`document.querySelector('dialog[open] input[role="switch"]').checked`)
  await read(`document.querySelector('dialog[open] button[aria-label="close"]').click()`)
  await until(`!document.querySelector('dialog[open]')`)
  const line = await read(`document.querySelector('button[aria-haspopup="dialog"] .sr-only').parentElement.textContent`)
  check(
    line === 'Starts with: glm-5.3 (house) · stops after each step · proposes a design first',
    `browser: and Propose design, switched on in its Harness, is in the line under the box (${JSON.stringify(line)})`,
  )
  const stored = await read(`localStorage.getItem('ab-start-settings') ?? ''`)
  check(stored === '{"design":true}', `browser: and this browser keeps the draft for the next start page (${JSON.stringify(stored)})`)
  await read(`${labelled('‹ Projects')}.click()`)
  await until(`!!${field}`)

  // Opening a project card is the interaction that mounts the whole workspace — chat pane
  // included, which is where it broke. The project's name is the card's button, and carries the label.
  // No `?.`: if the selector stops matching, the TypeError is reported as a page error and
  // fails the smoke, instead of it quietly passing while clicking nothing.
  await read(`document.querySelector('li button[aria-label^="open "]').click()`)

  // The chat the workspace just mounted was rebuilt from chat.json, and a reloaded turn's
  // reasoning is only there if toTurns kept it and Thinking rendered it. Opened by a real
  // click, because the panel's steps render only once it is open. No `?.` here either.
  const thinking = `document.querySelector('[data-thinking] > button')`
  await until(`!!${thinking}`, 10_000)
  const named = await read(`${NAMED}(${thinking})`)
  check(
    named === 'thinking: Plan the canvas. Then tools., 29 chars',
    `browser: a reloaded turn keeps a bubble a step, the first named by its opening words and size -> ${JSON.stringify(named)}`,
  )
  const before = await read(`${thinking}.getAttribute('aria-expanded')`)
  await read(`${thinking}.click()`)
  const opened = `document.getElementById(${thinking}.getAttribute('aria-controls'))`
  await until(`${opened}.textContent.length > 0`)
  const after = await read(`${thinking}.getAttribute('aria-expanded')`)
  check(before === 'false' && after === 'true', `browser: and a click opens it (aria-expanded ${before} -> ${after})`)
  const region = await read(`${opened}.textContent`)
  check(
    region.includes('Then tools.') && !region.includes('Check it on a phone.'),
    `browser: onto that step's reasoning, and only that step's (${JSON.stringify(region.slice(0, 60))})`,
  )

  // The code tab is a lazily imported chunk. If it never arrives the pane is blank and
  // every other check in this suite stays green — the exact shape of the white-page bugs
  // this file exists for. So click all the way through to a file and read the text back.
  const byLabel = (label: string) => `${labelled(label)}.click()`
  await read(byLabel('Code'))
  await until(`!!${labelled('Home.tsx')}`, 10_000)
  const files = await read(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' ')`)
  check(files.includes('Home.tsx'), 'browser: the code tab lists the project files')
  await read(byLabel('Home.tsx'))
  await until(`(document.querySelector('.cm-content')?.textContent ?? '').length > 0`, 10_000)
  const editor = await read(`document.querySelector('.cm-content')?.textContent?.slice(0, 200) ?? ''`)
  check(editor.includes('export default'), `browser: CodeMirror painted the file (${JSON.stringify(editor.slice(0, 40))})`)
  // The PUT assertions in check-preview prove the endpoint; this proves the only thing that
  // can reach it. A regression to the read-only editor leaves every one of them green.
  const editable = await read(`document.querySelector('.cm-content')?.getAttribute('contenteditable') ?? 'absent'`)
  check(editable === 'true', `browser: the editor is editable (contenteditable=${editable})`)

  // After the code tab, so the turns it plays cannot disturb the checks above; the watched
  // turn after them starts from a reload. The reloaded turn renders the collapsed line only:
  // the tail box, the rule that keeps it out while a step has sent only whitespace, the
  // observer that masks it, and an open panel's pin render only while a turn streams, and
  // a throw in any of them white-pages the chat.
  //
  // The chat and the panel are scrolled by real wheels, through the browser's input where a
  // reader's would land, so each move takes the browser's own path, scroll event and the
  // panel's overscroll-contain included. The chat is wheeled in its left padding, beside
  // every bubble, where no open panel can take the wheel instead. Each check of a scroll
  // first asserts the move it starts from, so none of them can pass by nothing having moved.
  const chat = `document.querySelector('[data-thinking]').closest('.overflow-y-auto')`
  const chatAt = `((s) => { const r = s.getBoundingClientRect(); return [r.left + 4, (r.top + r.bottom) / 2] })(${chat})`
  /** How far the chat's bottom is below its fold, in whole px. */
  const under = `((s) => Math.round(s.scrollHeight - s.scrollTop - s.clientHeight))(${chat})`
  const bottom = `((s) => s.scrollHeight - s.scrollTop - s.clientHeight <= 2)(${chat})`
  /** A wheel over `el` at the point `at` gives, and the wait for it to move. */
  const wheel = async (el: string, at: string, deltaY: number) => {
    const [x, y, top] = JSON.parse((await read(`JSON.stringify([...${at}, ${el}.scrollTop])`)) || '[0, 0, 0]') as number[]
    await page.mouse.move(x!, y!)
    await page.mouse.wheel(0, deltaY)
    await until(`${el}.scrollTop !== ${top}`)
  }
  // A reader who has scrolled up and then sends. The history, with the reloaded turn's
  // panel still open from above, is taller than the chat, or the wheel would move nothing.
  const spare = await read(`${chat}.scrollHeight - ${chat}.clientHeight`)
  await wheel(chat, chatAt, -200)
  const away = await read(under)
  const composer = `document.querySelector('textarea[placeholder^="make the heading"]')`
  /**
   * Types a message and sends it, the way the composer's own input and submit would, then
   * waits for the turn to reach the stub: __say is the new stream's. Send is there once no
   * turn runs, a watched one included, whose watcher polls every 2 s.
   */
  const compose = async (text: string) => {
    await read(
      `window.__say = undefined; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(${composer}, ${JSON.stringify(text)}); ${composer}.dispatchEvent(new Event('input', { bubbles: true }))`,
    )
    await until(`${composer}.form.querySelector('button[aria-label="send"]')?.disabled === false`, 5000)
    await read(`${composer}.form.requestSubmit()`)
    await until(`typeof window.__say === 'function'`)
  }
  await compose('a paint app')
  // No `?.` on __say: if the turn never reached the stub, the TypeError fails the smoke.
  const say = (...events: object[]) => read(events.map((e) => `window.__say(${JSON.stringify(e)})`).join('; '))
  const liveBtn = `[...document.querySelectorAll('[data-thinking] > button')].at(-1)`
  // The turn opens with a ✎ note, as one does after an edit in the code pane: the server
  // sends it before anything else, and it lands just above the turn.
  const note = `[...${chat}.querySelectorAll('summary')].at(-1)`
  const diff = Array.from({ length: 24 }, (_, i) => `+  <p>line ${i}</p>`)
  // Step 2 opens on a whitespace-only delta, as 6 of 1,566 measured GLM deltas were, and
  // the server labels it thinking. Its tail is nothing, so the button stays the line. The
  // events land in one task, so the note's being drawn means every one of them is.
  await say(
    { type: 'note', text: ['✎ These files were changed outside the chat:', 'M\tsrc/Home.tsx', '', ...diff].join('\n') },
    { type: 'thought', text: 'Step one reasons.', fresh: true },
    { type: 'activity', doing: 'thinking' },
    { type: 'activity', doing: 'waiting' },
    { type: 'thought', text: ' ', fresh: true },
    { type: 'activity', doing: 'thinking' },
  )
  await until(`!!${note}`)
  await frames()
  const blank = await read(`${SEEN}(${liveBtn})`)
  const sent = await read(under)
  check(
    Number(spare) >= 200 && Number(away) >= 100 && Number(sent) <= 2,
    `browser: a reader scrolled up a history taller than the chat is taken to its bottom by pressing send (${away} px above it, then ${sent}; ${spare} px to scroll)`,
  )
  check(
    blank === 'thinkingStep one reasons.17 chars',
    `browser: live, a step that has sent only whitespace has no bubble yet, and the one before shows its line -> ${JSON.stringify(blank)}`,
  )
  // Then a few words, which fit the box: it shows them and is not masked.
  await say({ type: 'thought', text: 'Short.' })
  await until(`!!${liveBtn}.querySelector('span[data-tail]')`)
  await frames()
  const short = await read(
    `((b) => { const t = b.querySelector('span[data-tail]'); return JSON.stringify([${SEEN}(b), t.hasAttribute('data-clipped'), getComputedStyle(t).maskImage]) })(${liveBtn})`,
  )
  // The reader, at the bottom of the turn, opens the note. That grows the chat with no
  // scroll, and the next send used to take them to the bottom, away from the diff. A tap,
  // not click(): the page's click handler runs before the browser opens a <details>, and
  // click() hides that, because it returns only once the browser has. A fix that re-read
  // the pin in a microtask passed with click() and failed every tap. The tap itself posts
  // the next send, so it runs straight after the tap, as a chunk that lands with the tap
  // does, and before the browser's own `toggle` a frame later: a fix on `onToggle` was
  // pulled down by it every time.
  const noteWas = await read(bottom)
  await read(
    `addEventListener('click', () => { const c = new MessageChannel(); c.port1.onmessage = () => window.__say({ type: 'thought', text: 'Then the brush.' }); c.port2.postMessage(0) }, { capture: true, once: true })`,
  )
  await tap(note)
  await until(`${note}.parentElement.open && ${liveBtn}.textContent.includes('Then the brush.')`)
  await frames()
  const noteStayed = await read(
    `${note}.parentElement.open && !${bottom} && ((r, v) => r.top >= v.top && r.bottom <= v.bottom)(${note}.getBoundingClientRect(), ${chat}.getBoundingClientRect())`,
  )
  check(
    noteWas === 'true' && noteStayed === 'true',
    `browser: a ✎ note tapped open mid-turn, at the bottom, is still in view after the next send (at bottom ${noteWas}, stayed ${noteStayed})`,
  )
  check(short === JSON.stringify(['thinking… Short.', false, 'none']), `browser: a few words that fit the tail box show unmasked (${short})`)
  // Shut again, with the chat back at its bottom, so the checks below start where they were
  // measured.
  await tap(note)
  await until(`!${note}.parentElement.open`)
  const left = Number(await read(under))
  if (left > 0) await wheel(chat, chatAt, left)
  // Then the step says far more than three lines.
  await say({ type: 'thought', text: 'word '.repeat(400) })
  await until(`${liveBtn}.textContent.includes('word word')`)
  await frames()
  const name = await read(`${NAMED}(${liveBtn})`)
  const clipped = await read(`${liveBtn}.querySelector('[data-clipped]') !== null`)
  check(
    name === 'thinking' && clipped === 'true',
    `browser: and once it says more than three lines, the tail box is masked, named "thinking" (${JSON.stringify(name)}, clipped ${clipped})`,
  )
  // The strip the panes sit in is a vertical scroller too, and the live "thinking" is an
  // sr-only box that escapes the chat's scroller to the unscrolled foot of the history. Unless
  // the chat pane clips it, that is the strip's to scroll, and a wheel over the composer —
  // outside the chat's scroller — slid the whole column up over nothing; so did script. First
  // that the box is under the fold, or a range of 0 would prove nothing.
  const strip = `document.getElementById('ab-chat').parentElement`
  /** The strip's vertical range, and where it and the page are scrolled to. */
  const stripAt = `JSON.stringify([${strip}.scrollHeight - ${strip}.clientHeight, ${strip}.scrollTop, document.scrollingElement.scrollTop])`
  const under200 = await read(
    `[...document.querySelectorAll('#ab-chat .sr-only')].some((n) => n.textContent === 'thinking' && n.getBoundingClientRect().top > ${strip}.getBoundingClientRect().bottom + 200)`,
  )
  // Not wheel(): nothing is meant to move, so there is no move to wait for. Two frames are
  // what a wheel that did scroll would take to show.
  const [cx, cy] = JSON.parse((await read(`JSON.stringify(((r) => [(r.left + r.right) / 2, (r.top + r.bottom) / 2])(${composer}.form.getBoundingClientRect()))`)) || '[0, 0]') as number[]
  await page.mouse.move(cx!, cy!)
  await page.mouse.wheel(0, 400)
  await frames()
  const stripWheeled = await read(stripAt)
  // [vertical range, strip scrollTop, page scrollTop]: the escaped box is clipped at its
  // pane, so the strip has nothing to scroll by wheel or by script.
  check(
    under200 === 'true' && stripWheeled === '[0,0,0]',
    `browser: mid-turn, the live "thinking" 200+ px under the fold gives the pane strip nothing to scroll, and a wheel over the composer moves neither it nor the page (${under200}, ${stripWheeled})`,
  )
  // Wheeled up while the model reasons, the chat stays put through the next thought. Back
  // at its bottom it follows again, here a tool row that grows the turn. Each read waits
  // for what was said to be on screen, and the layout effect that scrolls has run by then.
  const upFrom = await read(under)
  await wheel(chat, chatAt, -120)
  const up = await read(`${chat}.scrollTop`)
  const upUnder = await read(under)
  await say({ type: 'thought', text: ' still reasoning' })
  await until(`${liveBtn}.textContent.includes('still reasoning')`)
  const stayed = await read(`${chat}.scrollTop`)
  check(
    Number(upFrom) <= 2 && Number(upUnder) >= 100 && stayed === up,
    `browser: wheeled up mid-turn, the chat stays put through the next thought (${upFrom} then ${upUnder} px above its bottom, scrollTop ${up} -> ${stayed})`,
  )
  await wheel(chat, chatAt, Number(await read(under)))
  const height = await read(`${chat}.scrollHeight`)
  await say({ type: 'tool', id: 'w', name: 'write_file' })
  await until(`[...${chat}.querySelectorAll('li')].some((l) => l.textContent === 'write file')`)
  const grew = await read(`${chat}.scrollHeight - ${height}`)
  const follows = await read(under)
  check(
    Number(grew) > 0 && Number(follows) <= 2,
    `browser: and wheeled back to its bottom it follows again (a row grew it ${grew} px; ${follows} px from the bottom after)`,
  )
  // The row ended that step: its thinking is no longer the newest thing in the turn, so the
  // next step opens a bubble of its own under the row, and the checks below are on that one.
  // Long enough that its panel, opened, has something to scroll.
  await say({ type: 'thought', text: 'Then the palette. ' + 'word '.repeat(400), fresh: true })
  await until(`!!${liveBtn}.querySelector('[data-tail]')`)
  // A move up that the browser has made and not yet reported: a script's write, in the same
  // task as the next thought, whose commit then runs before the scroll event. hold() looks
  // before it writes, so the chat still lets go. Then back to the bottom.
  const nudged = await read(
    `(() => { const s = ${chat}; s.scrollTop -= 60; window.__say(${JSON.stringify({ type: 'thought', text: ' nudged' })}); return s.scrollTop })()`,
  )
  await until(`${liveBtn}.textContent.includes('nudged')`)
  const unmoved = await read(`${chat}.scrollTop`)
  const nudgeUnder = await read(under)
  check(
    Number(nudgeUnder) >= 50 && unmoved === nudged,
    `browser: and a move up it has not been told of yet, in the same task as a thought, still lets it go (scrollTop ${nudged} -> ${unmoved}, ${nudgeUnder} px above its bottom)`,
  )
  await wheel(chat, chatAt, Number(nudgeUnder))
  await read(`${liveBtn}.click()`)
  await until(`${liveBtn}.getAttribute('aria-expanded') === 'true'`)
  await frames()
  const expanded = await read(`${liveBtn}.getAttribute('aria-expanded')`)
  const openName = await read(`${NAMED}(${liveBtn})`)
  check(
    expanded === 'true' && openName === 'thinking',
    `browser: opened mid-turn, its name still holds still while the count moves (${JSON.stringify(openName)})`,
  )
  // Opening it scrolls it into view, which moves every scroller above it that has the room.
  const stripOpened = await read(stripAt)
  check(stripOpened === '[0,0,0]', `browser: and its scrollIntoView moves neither the pane strip nor the page (${stripOpened})`)
  const panel = `document.getElementById(${liveBtn}.getAttribute('aria-controls'))`
  const atEnd = `((r) => r.scrollHeight > r.clientHeight && r.scrollHeight - r.scrollTop - r.clientHeight <= 2)(${panel})`
  const length = `${panel}.textContent.length`
  const pinned = await read(atEnd)
  let was = await read(length)
  await say({ type: 'thought', text: 'more '.repeat(100) })
  await until(`${length} > ${was}`)
  await frames()
  const held = await read(atEnd)
  check(
    pinned === 'true' && held === 'true',
    `browser: and the live panel opens at its newest line and stays there on a send (${pinned}, ${held})`,
  )
  // The same for the panel: wheeled up it stays put while its text grows under it, and
  // wheeled back to its bottom it follows again. At the middle of what shows of it.
  const panelAt = `((p, s) => { const r = p.getBoundingClientRect(), v = s.getBoundingClientRect(); return [(r.left + r.right) / 2, (Math.max(r.top, v.top) + Math.min(r.bottom, v.bottom)) / 2] })(${panel}, ${chat})`
  await wheel(panel, panelAt, -120)
  const panelUnder = `((r) => Math.round(r.scrollHeight - r.scrollTop - r.clientHeight))(${panel})`
  const panelUp = await read(`${panel}.scrollTop`)
  const panelAway = await read(panelUnder)
  was = await read(length)
  await say({ type: 'thought', text: 'more '.repeat(100) })
  await until(`${length} > ${was}`)
  const panelStayed = await read(`${panel}.scrollTop`)
  check(
    Number(panelAway) >= 100 && panelStayed === panelUp,
    `browser: wheeled up, the panel stays put while its text grows (${panelAway} px above its bottom, scrollTop ${panelUp} -> ${panelStayed})`,
  )
  await wheel(panel, panelAt, Number(await read(panelUnder)))
  was = await read(length)
  await say({ type: 'thought', text: 'more '.repeat(100) })
  await until(`${length} > ${was}`)
  await frames()
  const panelFollows = await read(atEnd)
  check(panelFollows === 'true', `browser: and wheeled back to its bottom it follows again (${panelFollows})`)
  // The turn ends with the panel open, and it stays where the reader had it. Escape from
  // inside it closes it and gives its button the focus. Opened again it is a past turn's
  // panel, which opens at step 1: Chrome would otherwise restore the offset the hidden
  // region had when it closed, the newest line. A stream that ends without `done` is this tab
  // losing the turn (chatStore): it goes on watching, under the banner that says so, and the
  // reply stays drawn until the watcher's first poll, 2 s on — so the banner is what to wait for.
  const stop = `!!document.querySelector('button[aria-label="stop"]')`
  await read('window.__end()')
  await until(`[...document.querySelectorAll('p')].some((p) => p.textContent.includes("this tab isn't following"))`)
  await frames()
  const kept = await read(atEnd)
  const inside = await read(`${panel}.focus(), document.activeElement === ${panel}`)
  await page.keyboard.press('Escape')
  await until(`${liveBtn}.getAttribute('aria-expanded') === 'false'`)
  const escaped = await read(`${inside} + ' ' + ${liveBtn}.getAttribute('aria-expanded') + ' ' + (document.activeElement === ${liveBtn})`)
  await read(`${liveBtn}.click()`)
  await until(`${liveBtn}.getAttribute('aria-expanded') === 'true'`)
  await frames()
  const reopened = await read(`${panel}.scrollTop`)
  check(
    kept === 'true' && escaped === 'true false true' && reopened === '0',
    `browser: the turn's end leaves it there; Escape inside it closes it onto its button, and opened again it starts at step 1 (${kept}; focus inside, expanded, button focused: ${escaped}; scrollTop ${reopened})`,
  )

  // A code+chat restore reloads the chat from chat.json, which never got the turn above, and
  // the restored history has another turn in its place. Rows were keyed by index, so that
  // turn took over the live one's open panel and opened by itself. The panel opened at the
  // start is a stored turn's, and has to stay open.
  const live = await read(`${liveBtn}.getAttribute('aria-expanded')`)
  await read(`window.__later = ${JSON.stringify(LATER)}`)
  await read(byLabel('History'))
  const panels = `[...document.querySelectorAll('[data-thinking]')]`
  await until(`!!${labelled('Restore')}`)
  await read(byLabel('Restore'))
  await until(`${panels}.some((w) => w.parentElement.textContent.includes('Later.'))`)
  const restoredKept = await read(`${panels}[0].querySelector(':scope > button').getAttribute('aria-expanded')`)
  const later = await read(
    `${panels}.find((w) => w.parentElement.textContent.includes('Later.')).querySelector(':scope > button').getAttribute('aria-expanded')`,
  )
  check(
    live === 'true' && restoredKept === 'true' && later === 'false',
    `browser: after a code+chat restore an open panel stays with its turn, and none opens by itself (live ${live}, kept ${restoredKept}, later ${later})`,
  )

  // More › Settings mounts only while More shows, so nothing above has rendered it, and a
  // throw there would pass every other check. Its knobs come from STUB's catalog. Back to
  // History after, which is where the rest of this was written to run from.
  await read(byLabel('More'))
  const knob = `document.querySelector('#ab-preview input[placeholder="default 1"]')`
  await until(`!!${knob}`)
  const heading = await read(`document.querySelector('#ab-preview h2')?.textContent ?? ''`)
  check(heading === 'Settings', `browser: the More chip opens Settings (${JSON.stringify(heading)})`)
  const knobLabel = await read(`${knob}?.parentElement.querySelector('label').textContent.trim() ?? ''`)
  check(knobLabel.startsWith('Temperature'), `browser: and Settings draws the model's knobs from the catalog (${JSON.stringify(knobLabel)})`)
  // Artefacts mounts only while it shows, too, and draws the spec check-preview left there.
  await read(byLabel('Artefacts'))
  await until(`!!document.querySelector('#ab-preview article h2')`)
  const artefacts = {
    headings: await read(`[...document.querySelectorAll('#ab-preview article h2')].map((h) => h.textContent).join(' | ')`),
    persona: await read(`document.querySelector('#ab-preview article ul li p')?.textContent ?? ''`),
    step: await read(`document.querySelector('#ab-preview [aria-current=step] p')?.textContent ?? ''`),
    overflow: '',
  }
  // On a phone's width, where a wrapped step title once left its hidden status text 275 px
  // past the page's edge: Chrome's own phone emulation, as the CDP version set it, since a
  // context's isMobile cannot change after it is made. Then back to the smoke's own size.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await until('innerWidth === 390')
  await frames()
  artefacts.overflow = await read(`String(document.documentElement.scrollWidth - document.documentElement.clientWidth)`)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await page.setViewportSize({ width: 800, height: 600 })
  await until('innerWidth === 800')
  check(
    artefacts.headings === 'Plan · 1 of 2 done | Design brief | Spec' && artefacts.persona === 'Busy parent' &&
      artefacts.step === 'in progress: 2. History grid' && artefacts.overflow === '0',
    `browser: the Artefacts chip opens the plan, the design brief, then the spec, the step in progress marked (${JSON.stringify(artefacts)})`,
  )
  await read(byLabel('History'))
  await until(`!!${labelled('Restore')}`)

  // Then on a landscape phone's screen, the shortest the md layout gets: the chat was 215 px
  // tall there, and the open panel 236, so opening it showed its top and left the chat
  // unpinned, with the panel's newest lines under the fold. The width is the same md column
  // as the smoke's own 800x600. Turns of their own, so the checks above run at the size
  // they were measured at.
  await page.setViewportSize({ width: 844, height: 390 })
  await until('innerHeight === 390')
  await compose('the same, sideways')
  await say({ type: 'thought', text: 'word '.repeat(400), fresh: true }, { type: 'activity', doing: 'thinking' })
  await until(`!!${liveBtn}.querySelector('[data-tail]')`)
  await read(`${liveBtn}.click()`)
  await until(`${liveBtn}.getAttribute('aria-expanded') === 'true'`)
  await frames()
  // The reader was following, and still is: the chat at its bottom, and the panel at its
  // newest line with its foot inside the chat. That shows something only where the block
  // at the old cap would not have fit: its header, half the screen and its scroll margin,
  // against the chat.
  const inView = `${atEnd} && ${bottom} && ${panel}.getBoundingClientRect().bottom <= ${chat}.getBoundingClientRect().bottom + 1`
  const tight = await read(
    `((w) => ${chat}.clientHeight < w.firstElementChild.offsetHeight + Math.min(innerHeight / 2, 512) + parseFloat(getComputedStyle(w).scrollMarginBottom))(${panel}.parentElement)`,
  )
  const fitsOpen = await read(inView)
  was = await read(length)
  await say({ type: 'thought', text: 'more '.repeat(100) })
  await until(`${length} > ${was}`)
  await frames()
  const fitsSend = await read(inView)
  check(
    tight === 'true' && fitsOpen === 'true' && fitsSend === 'true',
    `browser: on an 844x390 screen the open panel fits the chat, which stays at its bottom with the panel's newest line in view (shorter than the old block ${tight}; ${fitsOpen}, ${fitsSend})`,
  )
  // `done` brings the usage line in under the chat, which makes it 33 px shorter, and the
  // panel's cap shrinks with it, without a send. The panel the reader kept open stays at its
  // newest line.
  const usageLine = `[...document.querySelectorAll('p')].some((p) => p.textContent.trim().startsWith('in 1 · cache'))`
  const high = await read(`${panel}.clientHeight`)
  await say({ type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })
  await read('window.__end()')
  await until(`${usageLine} && !${stop}`)
  await frames()
  const shrank = await read(`${high} - ${panel}.clientHeight`)
  const keptShort = await read(atEnd)
  check(
    Number(shrank) > 0 && keptShort === 'true',
    `browser: and when done brings the usage line in, the panel shrinks with the chat and stays at its newest line (${shrank} px, ${keptShort})`,
  )
  // One more turn, every panel shut, that writes a few lines and ends: `done` brings the
  // usage line in under the chat, 33 px of it, and the chat follows that too. Shut, because
  // an open panel's cap shrinks with the chat and hides a miss; lines of text, because after
  // a thought alone Chrome's scroll anchoring made up some or all of the 33 px by itself (a
  // chat that did not follow ended 0 to 14 px short, measured when the line was 29 px).
  // Read before the stream ends, because the activity line going then can clamp a chat
  // left short back down.
  await read(`document.querySelectorAll('[data-thinking] > button[aria-expanded="true"]').forEach((b) => b.click())`)
  await until(`!document.querySelector('[data-thinking] > button[aria-expanded="true"]')`)
  await compose('again')
  await say(
    { type: 'thought', text: 'Again.', fresh: true },
    { type: 'activity', doing: 'writing' },
    { type: 'text', text: 'Line one.\nLine two.\nLine three.' },
  )
  await until(`${chat}.textContent.includes('Line three.')`)
  await frames()
  const room = await read(`${chat}.clientHeight`)
  await say({ type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })
  await until(usageLine)
  await frames()
  const landed = await read(bottom)
  const dropped = await read(`${room} - ${chat}.clientHeight`)
  check(
    Number(dropped) > 0 && landed === 'true',
    `browser: a turn's done, which brings the usage line in under the chat, leaves the chat at its bottom (${dropped} px, ${landed})`,
  )
  await read('window.__end()')
  await until(`!${stop}`)
  await page.setViewportSize({ width: 800, height: 600 })
  await until('innerWidth === 800')

  // A reload mid-turn: the store starts over, load() finds the turn running, and the chat
  // only watches it, under the "a turn is running" banner. When it ends, one commit drops
  // that banner and adds the turn. With the banner inside the chat's scroller, Chrome's
  // scroll anchoring moved it up by the banner's height, the chat read that as the reader
  // scrolling up and let go, and the finished reply sat below the fold.
  await page.reload()
  await until(`!!document.querySelector('li button[aria-label^="open "]')`, 10_000)
  await read(WATCH)
  await read(`document.querySelector('li button[aria-label^="open "]').click()`)
  await until(`!!document.querySelector('[data-thinking]')`, 10_000)
  await frames()
  const tall = await read(`((s) => s.scrollHeight > s.clientHeight)(${chat})`)
  const openedAtBottom = await read(bottom)
  check(
    tall === 'true' && openedAtBottom === 'true',
    `browser: a watched turn's history, taller than the chat, opens at its bottom (${tall}, ${openedAtBottom})`,
  )
  // The watcher polls every 2 s.
  await read('window.__finish()')
  await until(`[...${chat}.querySelectorAll('div')].some((d) => d.textContent === 'Watched reply.')`, 10_000)
  await frames()
  const ended = await read(
    `${bottom} && ((s) => { const r = [...s.querySelectorAll('div')].find((d) => d.textContent === 'Watched reply.').getBoundingClientRect(), v = s.getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom })(${chat})`,
  )
  check(ended === 'true', `browser: and when the turn ends the chat is still there, with the reply in view (${ended})`)

  // ── the first build, landing while the project is open ─────────────────
  // A project of its own, made only now: the screens above open the newest one. Its turns are
  // STUB's, so their writes are made here — on disk first, then the settled row the server sends
  // for each, which is what has the workspace ask for the listing again.
  const api = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, url), { ...init, headers: { ...headers, 'content-type': 'application/json' } })
  const { slug } = (await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'First Build' }) })).json()) as { slug: string }
  const dir = join(projects, slug)
  const home = join(dir, 'src/Home.tsx')
  const template = await Bun.file(home).text()
  const message = `document.querySelector('textarea[aria-label="message"]')`
  const chip = (label: string) => `document.querySelector('[role="group"][aria-label="pane"] button[title="${label}"]')`
  /** The preview's frame, in view: neither off the right edge nor hidden behind another pane. */
  const framed = `((f) => !!f && ((r) => r.width > 0 && r.left < innerWidth - 50)(f.getBoundingClientRect()))(document.querySelector('#ab-preview iframe'))`
  /** A turn runs, sent or watched: the composer waits for it. */
  const running = `${message}.disabled`
  /** The project afresh, from a reload, its turns played by `stub`: STUB's sent ones, or WATCH's. */
  const open = async (stub: string) => {
    await page.reload()
    await until(`!!document.querySelector('li button[aria-label="open ${slug}"]')`, 10_000)
    await read(stub)
    await read(`document.querySelector('li button[aria-label="open ${slug}"]').click()`)
    await until(`!!${message}`, 10_000)
  }
  const send = async (text: string) => {
    await read(
      `window.__say = undefined; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(${message}, ${JSON.stringify(text)}); ${message}.dispatchEvent(new Event('input', { bubbles: true }))`,
    )
    await until(`${message}.form.querySelector('button[aria-label="send"]')?.disabled === false`, 5000)
    await read(`${message}.form.requestSubmit()`)
    await until(`typeof window.__say === 'function'`)
  }
  let calls = 0
  const writes = async (path: string, text: string) => {
    await Bun.write(join(dir, path), text)
    const id = `first-${++calls}`
    await say({ type: 'tool', id, name: 'write_file' }, { type: 'tool', id, name: 'write_file', path, done: true })
  }
  const end = async () => {
    await say({ type: 'done', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } })
    await read('window.__end()')
    await until(`!${running}`, 5000)
  }

  // The chat alone, and the page lands before the part it imports: the preview cannot serve it
  // yet, so the chat stays alone — given the listing's answer, and the time a slide would take.
  await open(STUB)
  await send('a tip splitter')
  const asked = page.waitForResponse((r) => r.url().endsWith('/api/projects'))
  await writes('src/Home.tsx', "import { Total } from './Total'\n\nexport default function Home() {\n  return <Total />\n}\n")
  await asked
  await until(framed, 3000)
  const early = await read(framed)
  check(early === 'false', `browser: a first build's page written before the part it imports does not slide in: the preview cannot serve it yet (${early})`)
  // A listing asked after one more write, the part still missing, is held — answered, built:
  // false, only once a newer one has said built and the preview has slid in. Late as it is, it
  // must not land: the frame, once in, stays in whatever the listing says, so it is the
  // composer, which reads `built` as it stands, that tells.
  let stale: unknown
  let release = () => {}
  await page.route(
    '**/api/projects',
    async (r) => {
      const answer = await r.fetch({ headers: { ...r.request().headers(), ...headers } })
      stale = r.request()
      await new Promise<void>((go) => (release = go))
      await r.fulfill({ response: answer })
    },
    { times: 1 },
  )
  await writes('src/notes.md', 'what each pays\n')
  for (const by = Date.now() + 5000; !stale && Date.now() < by; ) await Bun.sleep(50)
  await writes('src/Total.tsx', 'export function Total() {\n  return <p>Each pays 25.00</p>\n}\n')
  await until(framed, 5000)
  const slid = JSON.stringify([await read(framed), await read(running)])
  check(slid === '["true","true"]', `browser: once the part is on disk the preview slides in, the turn still running (${slid})`)
  const answered = page.waitForResponse((r) => r.request() === stale, { timeout: 5000 }).catch(() => null)
  release()
  await answered
  await frames()
  const keptIn = JSON.stringify([!!stale, await read(framed), await read(`${message}.placeholder`)])
  check(
    keptIn === '[true,"true","make the heading say…"]',
    `browser: and a listing asked before that and answered after it, built: false, does not land: the workspace stays built (${keptIn})`,
  )
  // A later listing that does say unbuilt — the page put back as the template's, which a stubbed
  // turn's end reports, having no commit to make — leaves the frame in: once in, it stays.
  await Bun.write(home, template)
  const listedAtEnd = page.waitForResponse((r) => r.url().endsWith('/api/projects'))
  await end()
  await listedAtEnd
  await frames()
  const stays = JSON.stringify([await read(`${message}.placeholder`), await read(framed)])
  check(stays === '["send a follow-up…","true"]', `browser: and a later listing that says unbuilt leaves the frame in, once it is in (${stays})`)

  // Reading Artefacts as the first build lands: the pane stays, and the Preview chip blinks, said
  // in a status for a screen reader, until it is opened.
  await Bun.write(home, template)
  await rm(join(dir, 'src/Total.tsx'), { force: true })
  await rm(join(dir, 'src/notes.md'), { force: true })
  await open(STUB)
  await read(`${chip('Artefacts')}.click()`)
  await until(`${chip('Artefacts')}.getAttribute('aria-pressed') === 'true'`)
  await send('the same, read beside the plan')
  await writes('src/Home.tsx', 'export default function Home() {\n  return <h1>Tip splitter</h1>\n}\n')
  await until(`!!${chip('Preview')}`, 5000)
  await frames()
  const blinking = `getComputedStyle(${chip('Preview')}.querySelector('svg')).animationName`
  const told = `[...document.querySelectorAll('[role="status"]')].some((s) => s.textContent.includes('ready in Preview'))`
  const beside = await read(`JSON.stringify([${chip('Artefacts')}.getAttribute('aria-pressed'), ${blinking}, ${told}])`)
  check(beside === '["true","blink",true]', `browser: reading Artefacts as the first build lands, the pane stays and the Preview chip blinks, said in a status (${beside})`)
  await read(`${chip('Preview')}.click()`)
  await until(framed, 5000)
  const shown = await read(`JSON.stringify([${chip('Preview')}.getAttribute('aria-pressed'), ${blinking}, ${told}, ${framed}])`)
  check(shown === '["true","none",false,true]', `browser: and the chip opens the preview, which ends the blink (${shown})`)
  await end()

  // A first build only watched — the page reloaded mid-turn — sends no writes down a stream: the
  // workspace asks for the listing itself while the turn runs, and the preview slides in as
  // Home.tsx lands, not at the turn's end.
  await Bun.write(home, template)
  await open(WATCH)
  await until(running, 5000)
  await Bun.write(home, 'export default function Home() {\n  return <h1>Watched build</h1>\n}\n')
  await until(framed, 8000)
  const watched = JSON.stringify([await read(framed), await read(running)])
  check(watched === '["true","true"]', `browser: a first build only watched slides in as Home.tsx lands, the turn still running (${watched})`)
  await read('window.__finish()')
  await until(`!${running}`, 5000)
  await api(`/api/projects/${slug}`, { method: 'DELETE' })
}
