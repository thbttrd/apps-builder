/**
 * `/_ab/fetch` over the line: the preview pod reaches nothing, so apps-builder
 * holds a long-poll into its control port and runs each relayed GET itself, with relayFetch's rules.
 * Here the pod's half (startControl + relayOverLine, and fetch-relay's plugin for the 502) and
 * apps-builder's (holdLine) run in one process; the site is a local upstream that the stubbed
 * private-address rule lets through, as check-preview's relay checks do.
 */
import http from 'node:http'
import { afterAll, expect, test } from 'bun:test'
import { fetchRelay, isPrivate } from '../server/fetch-relay.mjs'
import { relayOverLine, startControl } from '../server/preview-control.mjs'
import { holdLine } from '../server/line'
import { TMP } from './fixtures'

const TOKEN = 'line-test-token'
const listening = async (server: http.Server) => {
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

const site = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/moved') return Response.redirect(new URL('/feed', req.url).href, 302)
    if (path === '/feed') return new Response('<rss/>', { headers: { 'content-type': 'application/rss+xml' } })
    // A Response refuses 999; a raw socket answer does not.
    return new Response(`echo ${path}`, { headers: { 'content-type': 'text/plain' } })
  },
})
const weird = http.createServer((_req, res) => {
  res.writeHead(999, { 'content-type': 'text/plain' })
  res.end('not a standard status')
})
weird.listen(0, '127.0.0.1')
const weirdUrl = await listening(weird)
const siteUrl = `http://127.0.0.1:${site.port}`

const control = await listening(startControl({ root: TMP, token: TOKEN, port: 0, onFirstPush: () => {} }))
const held = new AbortController()
// Only the local upstream is let through: every other private address keeps the real rule.
holdLine(control, TOKEN, held.signal, { isPrivate: (ip: string) => ip !== '127.0.0.1' && isPrivate(ip) })

afterAll(() => {
  held.abort()
  site.stop(true)
  weird.close()
})

test("a relayed GET comes back with the site's status, type and final URL", async () => {
  const out = await relayOverLine(`${siteUrl}/moved`, { 'user-agent': 'Browser/1.0' })
  expect(out.status).toBe(200)
  expect(out.headers['content-type']).toBe('application/rss+xml')
  expect(out.headers['x-ab-final-url']).toBe(`${siteUrl}/feed`)
  expect(out.body.toString()).toBe('<rss/>')
})

test("a site's 999 comes back as 999", async () => {
  const out = await relayOverLine(`${weirdUrl}/`, {})
  expect(out.status).toBe(999)
  expect(out.body.toString()).toBe('not a standard status')
})

test('a private address is 403 and marked x-ab-relay-error', async () => {
  const out = await relayOverLine('http://192.168.100.1/', {})
  expect(out.status).toBe(403)
  expect(out.headers['x-ab-relay-error']).toBe('1')
  expect(out.body.toString()).toContain('not on the public internet')
})

test('ten relayed GETs at once all come back', async () => {
  const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => relayOverLine(`${siteUrl}/n${i}`, {})))
  expect(outs.map((o) => o.body.toString())).toEqual(Array.from({ length: 10 }, (_, i) => `echo /n${i}`))
})

test('a wrong token is 401 on both line routes', async () => {
  const wrong = { authorization: 'Bearer not-the-token' }
  expect((await fetch(`${control}/_ab/line`, { headers: wrong })).status).toBe(401)
  expect((await fetch(`${control}/_ab/line/x`, { method: 'POST', headers: wrong, body: '{}' })).status).toBe(401)
})

test('with no line held, the relay answers 502 marked x-ab-relay-error within 21 s', async () => {
  held.abort()
  // fetch-relay's plugin, as vite runs it: its middleware on a plain server.
  let middleware: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void = () => {}
  // @ts-expect-error the one part of vite's server the plugin touches
  fetchRelay().configureServer({ middlewares: { use: (fn: typeof middleware) => (middleware = fn) } })
  const preview = await listening(http.createServer((req, res) => middleware(req, res, () => res.end())).listen(0, '127.0.0.1'))
  const started = Date.now()
  const r = await fetch(`${preview}/_ab/fetch?url=${encodeURIComponent(`${siteUrl}/late`)}`)
  expect(r.status).toBe(502)
  expect(r.headers.get('x-ab-relay-error')).toBe('1')
  expect(Date.now() - started).toBeLessThan(21_000)
}, 25_000)

// The control port answers from inside the pod, where the model's code runs: should the preview's
// container die, the app's server could bind :5174 and answer the polls itself. Its answers are data.
test('a poll answer that is too large or not a job is dropped, and polling goes on', async () => {
  let polls = 0
  let answered = 0
  const rogue = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (req.method === 'POST') answered++
      else polls++
      if (polls % 2) return new Response('x'.repeat(1024 * 1024), { headers: { 'content-type': 'application/json' } })
      return Response.json({ id: '../../x', url: 42, headers: 'nope' })
    },
  })
  const stop = new AbortController()
  holdLine(`http://127.0.0.1:${rogue.port}`, TOKEN, stop.signal)
  await Bun.sleep(2500)
  stop.abort()
  rogue.stop(true)
  expect(polls).toBeGreaterThan(2)
  expect(answered).toBe(0)
}, 10_000)

test('at most 8 relayed GETs run at once on one line', async () => {
  let running = 0
  let most = 0
  const slow = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch() {
      most = Math.max(most, ++running)
      await Bun.sleep(200)
      running--
      return new Response('slow')
    },
  })
  let handed = 0
  const flood = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      if (req.method === 'POST') return new Response(null, { status: 204 })
      if (handed >= 20) return new Response(null, { status: 204 })
      return Response.json({ id: crypto.randomUUID(), url: `http://127.0.0.1:${slow.port}/${handed++}`, headers: {} })
    },
  })
  const stop = new AbortController()
  holdLine(`http://127.0.0.1:${flood.port}`, TOKEN, stop.signal, { isPrivate: (ip: string) => ip !== '127.0.0.1' && isPrivate(ip) })
  for (let i = 0; i < 100 && handed < 20; i++) await Bun.sleep(50)
  await Bun.sleep(400)
  stop.abort()
  slow.stop(true)
  flood.stop(true)
  expect(handed).toBe(20)
  expect(most).toBeLessThanOrEqual(8)
}, 15_000)
