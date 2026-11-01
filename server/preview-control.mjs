// @ts-check
/**
 * A preview's control port, beside vite's, in the preview's container. Two things:
 * - the push: the pod's /app starts empty; apps-builder pushes the project's source here, then every
 *   change, and vite starts after the first push. Writes made in the container are the ones vite's
 *   watcher hears (under gVisor a write from outside the container is not signalled, measured 2026-10-21).
 * - the line: the pod reaches nothing, so `/_ab/fetch` (fetch-relay.mjs's plugin) queues each relayed GET
 *   here, and apps-builder takes them with a long-poll (`GET /_ab/line`) and posts each answer back
 *   (`POST /_ab/line/<id>`): server/line.ts. A long-poll, not a websocket: node has no websocket server
 *   without a dependency.
 *
 * Only apps-builder reaches this port from outside the pod (the preview profile's one exception), but
 * the app's server shares the pod's loopback and runs the model's code: every route wants the token
 * apps-builder put in this container's environment alone.
 *
 * Plain JS with JSDoc, like preview-vite.mjs, which imports it under the pod's node.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { lstatSync, mkdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Never pushed, never written: the image's node_modules, the project's git and apps-builder's own files. */
export const EXCLUDED = ['node_modules', '.git', '.apps-builder', 'dist']
const MAX_PUSH = 32 * 1024 * 1024
/** relayFetch's own deadline is 15 s; this covers apps-builder taking the request too. */
const LINE_TIMEOUT_MS = 20_000
/** A poll answers 204 after this, and apps-builder polls again. */
const POLL_MS = 25_000
/** A relayed body is at most fetch-relay's MAX_BYTES (5 MB), base64 in JSON. */
const MAX_ANSWER = 8 * 1024 * 1024

/** @typedef {{ id: string, url: string, headers: Record<string, string> }} Job */
/** @typedef {{ status: number, headers: Record<string, string>, body: Buffer }} Relayed */
/** Relayed GETs no poll has taken yet, oldest first. @type {Job[]} */
const queued = []
/** Polls waiting for a GET. @type {((job: Job) => void)[]} */
const polls = []
/** Taken or queued GETs, by id, until answered or timed out. @type {Map<string, { ok: (r: Relayed) => void, timer: NodeJS.Timeout }>} */
const pending = new Map()

/**
 * One relayed GET, asked of apps-builder over the line. Rejects when nothing answers in LINE_TIMEOUT_MS:
 * apps-builder not holding the line, or gone.
 * @param {string} target
 * @param {Record<string, string>} headers
 * @returns {Promise<Relayed>}
 */
export function relayOverLine(target, headers) {
  return new Promise((ok, fail) => {
    const job = { id: randomUUID(), url: target, headers }
    const timer = setTimeout(() => {
      pending.delete(job.id)
      const at = queued.indexOf(job)
      if (at >= 0) queued.splice(at, 1)
      fail(new Error(`no answer in ${LINE_TIMEOUT_MS / 1000}s`))
    }, LINE_TIMEOUT_MS)
    pending.set(job.id, { ok, timer })
    const poll = polls.shift()
    if (poll) poll(job)
    else queued.push(job)
  })
}

/**
 * `path`'s absolute place under `root`, or null when it is no file of the project's: absolute, empty,
 * NUL, out of root (by `..` or through a symlink on the way), or under an excluded name.
 * @param {string} root
 * @param {string} path
 * @returns {string | null}
 */
export function confine(root, path) {
  if (!path || path.includes('\0') || isAbsolute(path)) return null
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  if (EXCLUDED.includes(rel.split(sep)[0] ?? '')) return null
  // The deepest part that exists, symlinks resolved, must still be under root: a link in the way
  // (or the file itself a link) would carry the write out.
  let existing = full
  while (!exists(existing)) existing = dirname(existing)
  const real = realpathSync(existing)
  const realRoot = realpathSync(root)
  return real === realRoot || real.startsWith(realRoot + sep) ? full : null
}

/** @param {string} p */
const exists = (p) => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * @param {string | undefined} header
 * @param {string} token
 */
const authorized = (header, token) => {
  const got = Buffer.from(header ?? '')
  const want = Buffer.from(`Bearer ${token}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * @param {{ root: string, token: string, port: number, onFirstPush: () => void }} options
 * @returns {http.Server}
 */
export function startControl({ root, token, port, onFirstPush }) {
  let pushed = false
  /** @type {(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>} */
  const handle = async (req, res) => {
    /** @param {number} status @param {string} [text] */
    const answer = (status, text) => {
      res.writeHead(status, text ? { 'content-type': 'text/plain; charset=utf-8' } : {})
      res.end(text)
    }
    if (!authorized(req.headers.authorization, token)) return answer(401)
    if (req.method === 'GET' && req.url === '/_ab/line') return take(req, res)
    const id = req.method === 'POST' && req.url?.startsWith('/_ab/line/') ? req.url.slice('/_ab/line/'.length) : null
    if (id !== null) return settle(id, req, answer)
    if (req.method !== 'POST' || req.url !== '/_ab/push') return answer(404)
    let body
    try {
      body = await read(req, MAX_PUSH)
    } catch {
      res.setHeader('connection', 'close')
      return answer(413, `a push is at most ${MAX_PUSH} bytes`)
    }
    /** @type {Record<string, string | null>} */
    let files
    try {
      files = JSON.parse(body.toString()).files
      if (!files || typeof files !== 'object') throw new Error()
    } catch {
      return answer(400, 'want {"files": {"<path>": "<base64>" | null}}')
    }
    const places = Object.entries(files).map(([path, data]) => [confine(root, path), data, path])
    const bad = places.find(([place, data]) => !place || (data !== null && typeof data !== 'string'))
    if (bad) return answer(400, `refused: ${JSON.stringify(bad[2])}`)
    for (const [place, data] of /** @type {[string, string | null, string][]} */ (places)) {
      if (data === null) remove(root, place)
      else {
        mkdirSync(dirname(place), { recursive: true })
        writeFileSync(place, Buffer.from(data, 'base64'))
      }
    }
    answer(204)
    if (!pushed) {
      pushed = true
      onFirstPush()
    }
  }
  // An async handler's throw — a write the disk refuses, a path that is a file — would be an unhandled
  // rejection, which ends this node and vite with it: answered 500 instead, and sync sends it again.
  const server = http.createServer((req, res) =>
    handle(req, res).catch((/** @type {Error} */ e) => {
      if (res.headersSent) return void res.destroy()
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`refused: ${e.message}`)
    }),
  )
  server.listen(port)
  return server
}

/**
 * A poll: the oldest queued GET now, or the next one to come, or 204 after POLL_MS. A poll whose client
 * went away gives up its place, so no GET is handed to a dead connection.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function take(req, res) {
  /** @param {Job} job */
  const send = (job) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(job))
  }
  const job = queued.shift()
  if (job) return send(job)
  /** @param {Job} job */
  const give = (job) => {
    clearTimeout(timer)
    send(job)
  }
  const timer = setTimeout(() => {
    drop()
    res.writeHead(204)
    res.end()
  }, POLL_MS)
  const drop = () => {
    const at = polls.indexOf(give)
    if (at >= 0) polls.splice(at, 1)
  }
  req.on('close', () => {
    clearTimeout(timer)
    drop()
  })
  polls.push(give)
}

/**
 * apps-builder's answer to one taken GET.
 * @param {string} id
 * @param {http.IncomingMessage} req
 * @param {(status: number, text?: string) => void} answer
 */
async function settle(id, req, answer) {
  const waiting = pending.get(id)
  if (!waiting) return answer(404)
  /** @type {{ status: number, headers: Record<string, string>, body: string }} */
  let out
  try {
    out = JSON.parse((await read(req, MAX_ANSWER)).toString())
  } catch {
    return answer(400)
  }
  pending.delete(id)
  clearTimeout(waiting.timer)
  waiting.ok({ status: out.status, headers: out.headers ?? {}, body: Buffer.from(out.body ?? '', 'base64') })
  answer(204)
}

/**
 * The file, then each parent left empty, up to and never including root.
 * @param {string} root
 * @param {string} place
 */
function remove(root, place) {
  rmSync(place, { force: true, recursive: true })
  for (let dir = dirname(place); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
    try {
      rmdirSync(dir)
    } catch {
      return
    }
  }
}

/**
 * The request's body, or a throw once it passes `max` bytes.
 * @param {http.IncomingMessage} req
 * @param {number} max
 * @returns {Promise<Buffer>}
 */
function read(req, max) {
  return new Promise((ok, fail) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length
      if (size > max) {
        req.pause()
        fail(new Error('too large'))
      } else chunks.push(chunk)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

