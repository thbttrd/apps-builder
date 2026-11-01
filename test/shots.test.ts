/**
 * screenshot() takes a preview's picture in the browser pilot.ts drives. A page that
 * keeps the network busy — an app polling its /api every 100 ms — must still be photographed: waiting for
 * `networkidle` alone never ended for it.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { getBrowser, slot } from '../server/pilot'
import { chromePath, screenshot } from '../server/shots'
import { TMP } from './fixtures'

/** Pages the browser asked for (its user agent says HeadlessChrome; screenshot()'s liveness fetch is Bun's). */
let browserHits = 0
const page = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (req) => {
    if (req.headers.get('user-agent')?.includes('HeadlessChrome')) browserHits++
    return new URL(req.url).pathname === '/ping'
      ? new Response('pong')
      : new Response('<h1>busy</h1><script>setInterval(() => fetch("/ping"), 100)</script>', { headers: { 'content-type': 'text/html' } })
  },
})
afterAll(async () => {
  page.stop(true)
  await (await getBrowser()).close()
})

test.skipIf(!chromePath())('a page that polls without end is still photographed, in seconds', async () => {
  mkdirSync(TMP, { recursive: true })
  const out = join(TMP, 'busy.png')
  const started = Date.now()
  expect(await screenshot(`http://127.0.0.1:${page.port}/`, out)).toBe(true)
  expect(existsSync(out)).toBe(true)
  expect(Date.now() - started).toBeLessThan(15_000)
}, 40_000)

test.skipIf(!chromePath())("a picture waits for a free page, as check_app does: the browser holds two at most", async () => {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const both = [slot(() => held), slot(() => held)]
  const hits = browserHits
  const shot = screenshot(`http://127.0.0.1:${page.port}/`, join(TMP, 'queued.png'))
  await Bun.sleep(1500)
  expect(browserHits).toBe(hits) // no page opened while both are taken
  release()
  await Promise.all(both)
  expect(await shot).toBe(true)
  expect(browserHits).toBeGreaterThan(hits)
}, 40_000)
