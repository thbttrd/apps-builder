/**
 * A crashed preview is painted, not left white (crash-overlay.mjs): the script the preview's vite puts in
 * every app's page, here in the browser pilot.ts drives, on pages served by a Bun.serve.
 */
import { afterAll, expect, test } from 'bun:test'
import { crashOverlay } from '../server/crash-overlay.mjs'
import { getBrowser } from '../server/pilot'
import { chromePath } from '../server/shots'

const script = crashOverlay().transformIndexHtml()[0]!.children
/** An app's page: the overlay's script first, as vite injects it, then the app's own. */
const pages: Record<string, string> = {
  // A render crash: React reports it and unmounts the root, which stays empty.
  '/crash': `<div id="root"></div><script>setTimeout(() => { throw new TypeError("Cannot read properties of undefined (reading 'map')") })</script>`,
  // An error in a handler, the app still on screen: not a crash.
  '/alive': `<div id="root"><h1>Still here</h1></div><script>setTimeout(() => { throw new Error('a click went wrong') })</script>`,
  // A crash the app recovers from (a fix, hot-reloaded): the root renders again.
  '/recovers': `<div id="root"></div><script>setTimeout(() => { throw new Error('first try') }); setTimeout(() => { document.getElementById('root').innerHTML = '<h1>Fixed</h1>' }, 600)</script>`,
}
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => new Response(`<!doctype html><html><head><script>${script}</script></head><body>${pages[new URL(req.url).pathname]}</body></html>`, { headers: { 'content-type': 'text/html' } }),
})
afterAll(async () => {
  server.stop(true)
  await (await getBrowser()).close()
})

async function open(path: string) {
  const page = await (await getBrowser()).newPage()
  page.on('pageerror', () => {})
  await page.goto(`http://127.0.0.1:${server.port}${path}`)
  return page
}

test.skipIf(!chromePath())('a crash that leaves the root empty shows its error, outside the root', async () => {
  const page = await open('/crash')
  await page.waitForSelector('#ab-crash', { timeout: 3000 })
  expect(await page.textContent('#ab-crash')).toContain("reading 'map'")
  // check_app's APP CRASHED still holds: the root itself is empty.
  expect(await page.evaluate(() => document.getElementById('root')!.innerHTML)).toBe('')
  await page.close()
}, 20_000)

test.skipIf(!chromePath())('an error while the app is on screen paints nothing over it', async () => {
  const page = await open('/alive')
  await Bun.sleep(500)
  expect(await page.$('#ab-crash')).toBeNull()
  await page.close()
}, 20_000)

test.skipIf(!chromePath())('the error goes once the app renders again', async () => {
  const page = await open('/recovers')
  await page.waitForSelector('#ab-crash', { timeout: 3000 })
  await page.waitForSelector('#ab-crash', { state: 'detached', timeout: 3000 })
  expect(await page.textContent('#root')).toBe('Fixed')
  await page.close()
}, 20_000)
