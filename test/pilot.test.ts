/**
 * The browser pilot.ts drives over CDP. On the cluster it is a pod of its own behind a Service (the cluster's GitOps repo
 * apps/apps-builder-staging), so AB_BROWSER_CDP names a host, and Chrome answers its DevTools endpoint only to
 * a Host that is an IP address or localhost: "Host header is specified and is not an IP address or localhost"
 * (measured 2026-10-22, the headless shell). Here a real headless shell on the loopback, named
 * localhost.localdomain: /etc/hosts resolves it to 127.0.0.1, and Chrome refuses it as it refuses a Service's.
 */
import { lookup } from 'node:dns/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { chromium } from 'playwright-core'
import { cdpEndpoint, checkApp, targetOf } from '../server/pilot'
import { chromePath } from '../server/shots'

const name = 'localhost.localdomain'
const address = await lookup(name, { family: 4 }).then((a) => a.address, () => '')

test.skipIf(!chromePath() || address !== '127.0.0.1')("a browser named by a host name is driven: the name is resolved first", async () => {
  const port = 30_000 + Math.floor(Math.random() * 20_000)
  const profile = mkdtempSync(join(tmpdir(), 'ab-cdp-'))
  const chrome = Bun.spawn([chromePath()!, `--remote-debugging-port=${port}`, `--remote-debugging-address=${address}`,
    '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    for (let i = 0; i < 40 && !(await fetch(`http://${address}:${port}/json/version`).then((r) => r.ok, () => false)); i++) await Bun.sleep(250)
    const browser = await chromium.connectOverCDP(await cdpEndpoint(`http://${name}:${port}`))
    expect(browser.version()).toMatch(/^\d+\./)
    await browser.close()
  } finally {
    chrome.kill()
    await chrome.exited
    rmSync(profile, { recursive: true, force: true })
  }
}, 30_000)

test("a step's target names what the outline names: its quotes unescaped, as the outline prints them escaped", () => {
  // The outline is YAML: `checkbox "Mark \"Learn React\" as done"` (a todo turn spent its last steps on it, 2026-09-24).
  expect(targetOf('checkbox "Mark \\"Learn React\\" as done"')).toEqual({ role: 'checkbox', name: 'Mark "Learn React" as done' })
  expect(targetOf('checkbox "Mark "Learn React" as done"')).toEqual({ role: 'checkbox', name: 'Mark "Learn React" as done' })
  expect(targetOf('button "Save"')).toEqual({ role: 'button', name: 'Save' })
  expect(targetOf(' Add a todo ')).toEqual({ name: 'Add a todo' })
})

test.skipIf(!chromePath())("check_app holds an approved design's app to its tokens: OFF-DESIGN, and no 'no errors'", async () => {
  const page = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (req) =>
      new Response(
        new URL(req.url).pathname === '/form'
          ? // A field left focused by a fill step: the browser's own focus ring is not the app's colour.
            '<!doctype html><html style="background:#fff;color:#171717;font-family:Arial"><body><div id="root"><h1>Tips</h1><input aria-label="Bill" style="font:inherit;color:inherit;background:#fff;border:0"></div></body></html>'
          : '<!doctype html><html style="background:#fff;color:#171717;font-family:Arial"><body><div id="root"><h1>Tips</h1><p style="color:#ff00ff">Total</p></div></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
  })
  try {
    const theme = { '--color-ink': '#171717', '--color-canvas': '#ffffff', '--font-body': 'Arial' }
    const held = await checkApp(tmpdir(), `http://127.0.0.1:${page.port}`, '/', 'desktop', [], undefined, theme)
    expect(held).toContain('OFF-DESIGN')
    expect(held).toContain('#ff00ff is not a token')
    expect(held).not.toContain('no errors')
    const free = await checkApp(tmpdir(), `http://127.0.0.1:${page.port}`)
    expect(free).not.toContain('OFF-DESIGN')
    const filled = await checkApp(tmpdir(), `http://127.0.0.1:${page.port}`, '/form', 'desktop', [{ do: 'fill', target: 'textbox "Bill"', value: '42' }], undefined, theme)
    expect(filled).not.toContain('OFF-DESIGN')
  } finally {
    page.stop(true)
  }
}, 60_000)
