// @ts-check
/**
 * The preview's way out to other sites: `GET /_ab/fetch?url=<http(s) URL>` fetches that URL
 * from the server and answers on the preview's own origin, where the browser's CORS rule
 * does not apply. Browsers refuse to let a page read most other sites (they send no
 * Access-Control-Allow-Origin), and the public CORS proxies models reach for are dead or
 * want an API key — measured 2026-09-26 on feed-reader-01, whose every route failed.
 *
 * Answered on each preview's own origin (see preview-vite.mjs), not by the dispatcher: check_app
 * and the screenshotter load http://127.0.0.1:<port> directly, and a route only the
 * dispatcher knew would be invisible to the one browser that checks the app's work.
 *
 * In two halves, because the preview's pod has no network (pod.ts): the vite plugin at the
 * bottom queues each request on the line (preview-control.mjs), apps-builder takes it from there
 * (line.ts) and runs relayFetch — the only code here that reaches another site.
 *
 * Plain JS with JSDoc, not TS: the plugin runs inside vite under the pod's `node`, which does
 * not strip types. tsc still checks it (allowJs + checkJs in tsconfig.json).
 */
import { lookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import zlib from 'node:zlib'
import { relayOverLine } from './preview-control.mjs'

const RELAY_PATH = '/_ab/fetch'
const TIMEOUT_MS = 15_000
/** Decompressed. A feed is ~100 KB; a page of JSON rarely a tenth of this. */
export const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
/** Passed through from the browser: a site that serves browsers should serve this too. */
const FORWARDED = ['accept', 'accept-language', 'user-agent']

// ── what may not be reached ────────────────────────────────────────────────
// Everything that is not the public internet. The relay runs on the dev server, beside the LAN,
// garage, the VPN (100.64/10) and apps-builder's own ports — none of which a preview
// page has any business reading through it.

/** @type {[string, number][]} */
const PRIVATE_V4 = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT, and the VPN
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local: the host mapping 169.254.1.2, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
]

/** @type {[string, number][]} */
const PRIVATE_V6 = [
  ['::', 96], // unspecified, loopback, and the deprecated IPv4-compatible range
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]

/** @param {string} ip dotted quad */
const v4 = (ip) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0)

/** @param {string} ip any textual IPv6, zone and dotted tail included */
function v6(ip) {
  let s = (ip.split('%')[0] ?? '').toLowerCase()
  // ::ffff:1.2.3.4 — rewrite the dotted tail as the two hextets it is
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  if (tail) {
    const n = v4(tail)
    s = `${s.slice(0, -tail.length)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`
  }
  const [head = '', rest] = s.split('::')
  const left = head ? head.split(':') : []
  const right = rest ? rest.split(':') : []
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n)
}

const V4_RANGES = PRIVATE_V4.map(([base, bits]) => ({ base: v4(base), size: 2 ** (32 - bits) }))
const V6_RANGES = PRIVATE_V6.map(([base, bits]) => ({ shift: BigInt(128 - bits), prefix: v6(base) >> BigInt(128 - bits) }))
/** The top 96 bits of ::ffff:a.b.c.d and of 64:ff9b::a.b.c.d, which carry an IPv4 address. */
const MAPPED = 0xffffn
const NAT64 = v6('64:ff9b::') >> 32n

/**
 * Whether an address is off limits. Anything that is not a valid IP is, too: this is only
 * ever asked about what a resolver or a URL produced, and a surprise there is a refusal.
 * @param {string} ip
 */
export function isPrivate(ip) {
  const bare = ip.replace(/^\[|\]$/g, '')
  const family = isIP(bare.split('%')[0] ?? '')
  if (family === 4) {
    const n = v4(bare)
    return V4_RANGES.some((r) => n >= r.base && n < r.base + r.size)
  }
  if (family !== 6) return true
  const n = v6(bare)
  // judge the IPv4 address inside, not the wrapper around it
  if (n >> 32n === MAPPED || n >> 32n === NAT64) {
    return isPrivate([24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn)).join('.'))
  }
  return V6_RANGES.some((r) => n >> r.shift === r.prefix)
}

/**
 * A resolver that refuses private answers. It is the socket's own lookup, so the address
 * checked is the address dialled: resolving once to check and letting the request resolve
 * again would leave a DNS-rebinding window between the two. IP literals never reach a
 * lookup, which is why relayFetch checks those itself.
 * @param {(ip: string) => boolean} privateAddress
 * @returns {import('node:net').LookupFunction}
 */
const guarded = (privateAddress) => (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const refused = addresses.find((a) => privateAddress(a.address))
    if (refused || !addresses[0]) {
      const e = /** @type {NodeJS.ErrnoException} */ (
        new Error(`${hostname} resolves to ${refused?.address ?? 'nothing'}, which is not on the public internet`)
      )
      e.code = 'EPRIVATE'
      return callback(e, '', 0)
    }
    // Node asks for every address when it races IPv4 against IPv6 (autoSelectFamily).
    if (options.all) return /** @type {any} */ (callback)(null, addresses)
    callback(null, addresses[0].address, addresses[0].family)
  })
}

// ── the fetch ──────────────────────────────────────────────────────────────

/**
 * @typedef {{ status: number, headers: Record<string, string>, body: Buffer }} Relayed
 * @typedef {{ headers?: Record<string, string | undefined>, isPrivate?: (ip: string) => boolean }} Options
 */

/** A refusal with the status the browser should see and a sentence the model can act on. */
export class RelayError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Fetch `target` the way the browser would have, had CORS let it: follow redirects, undo
 * compression, hand back the status and body as they came. Refuses anything that is not
 * http(s) to a public address, at every hop.
 *
 * `isPrivate` is replaceable for the check suite only, whose upstream has to be local.
 * @param {string} target
 * @param {Options} [options]
 * @returns {Promise<Relayed>}
 */
export async function relayFetch(target, options = {}) {
  const privateAddress = options.isPrivate ?? isPrivate
  // One deadline for the whole fetch, redirects and body included: a per-socket idle
  // timeout would let a site that drips a byte every few seconds hold the relay forever.
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  let url = parseTarget(target)
  for (let hop = 0; ; hop++) {
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && privateAddress(url.hostname)) {
      throw new RelayError(403, `${url.hostname} is not on the public internet; the relay only reaches public sites`)
    }
    const res = await get(url, options.headers ?? {}, privateAddress, deadline)
    const location = res.headers.location
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume()
      if (hop === MAX_REDIRECTS) throw new RelayError(502, `${target} redirected more than ${MAX_REDIRECTS} times`)
      url = parseTarget(new URL(location, url).href)
      continue
    }
    const body = await read(res, url)
    const type = res.headers['content-type']
    return {
      status: res.statusCode ?? 502,
      headers: {
        ...(type ? { 'content-type': type } : {}),
        // Where the answer really came from: a feed's relative links resolve against this.
        'x-ab-final-url': url.href,
      },
      body,
    }
  }
}

/** @param {string} target */
function parseTarget(target) {
  /** @type {URL} */
  let url
  try {
    url = new URL(target)
  } catch {
    throw new RelayError(400, `url must be an absolute http(s) address, got ${JSON.stringify(target.slice(0, 200))}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RelayError(400, `only http and https can be fetched, not ${url.protocol}`)
  }
  if (url.username || url.password) throw new RelayError(400, 'credentials in the url are not relayed')
  return url
}

/**
 * One GET, no redirects followed: relayFetch follows them, so every hop is checked.
 * @param {URL} url
 * @param {Record<string, string | undefined>} forwarded
 * @param {(ip: string) => boolean} privateAddress
 * @param {AbortSignal} deadline
 * @returns {Promise<http.IncomingMessage>}
 */
function get(url, forwarded, privateAddress, deadline) {
  /** @type {Record<string, string>} */
  const headers = { 'accept-encoding': 'gzip, deflate, br' }
  for (const name of FORWARDED) {
    const value = forwarded[name]
    if (value) headers[name] = value
  }
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'GET', headers, lookup: guarded(privateAddress), signal: deadline },
      resolve,
    )
    req.on('error', (e) => reject(failure(e, url)))
    req.end()
  })
}

/**
 * What went wrong, as the status the browser gets and a sentence the model can act on.
 * @param {Error} e
 * @param {URL} url
 */
function failure(e, url) {
  const code = /** @type {NodeJS.ErrnoException} */ (e).code
  if (e instanceof RelayError) return e
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return new RelayError(504, `${url.host} did not answer within ${TIMEOUT_MS / 1000}s`)
  }
  if (code === 'EPRIVATE') return new RelayError(403, `${e.message}; the relay only reaches public sites`)
  if (code === 'ENOTFOUND') return new RelayError(502, `${url.hostname} does not resolve — check the address`)
  return new RelayError(502, `could not reach ${url.host}: ${code ?? e.message}`)
}

/**
 * The whole body, decompressed, or a refusal once it passes MAX_BYTES.
 * @param {http.IncomingMessage} res
 * @param {URL} url
 * @returns {Promise<Buffer>}
 */
function read(res, url) {
  const encoding = (res.headers['content-encoding'] ?? '').trim().toLowerCase()
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : undefined
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    /** @param {Error} e */
    const fail = (e) => {
      res.destroy()
      decoder?.destroy()
      reject(e)
    }
    // Both ends: pipe() does not carry the source's errors to the decoder, and a dropped
    // connection or the deadline surfaces on `res` alone.
    res.on('error', (e) => fail(failure(e, url)))
    const stream = decoder ? res.pipe(decoder) : res
    if (decoder) decoder.on('error', (e) => fail(new RelayError(502, `${url.host} sent a body that would not decompress: ${e.message}`)))
    stream.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length
      if (size > MAX_BYTES) fail(new RelayError(502, `the response is larger than ${MAX_BYTES / 1024 / 1024} MB`))
      else chunks.push(chunk)
    })
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

// ── the vite plugin ────────────────────────────────────────────────────────

/**
 * Mounts RELAY_PATH on a preview's dev server, ahead of vite's own middleware — its SPA
 * fallback would otherwise answer every /_ab/fetch with index.html and a 200.
 * @returns {import('vite').Plugin}
 */
export function fetchRelay() {
  return {
    name: 'apps-builder:fetch-relay',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Every path passes through here, `//[` included, and new URL throws on that one.
        // connect never sees a throw from an async handler: it becomes an unhandled
        // rejection, which leaves the request hanging under bun and kills the whole
        // preview under the host's node. Not ours, so vite answers it as it always did.
        /** @type {URL} */
        let here
        try {
          here = new URL(req.url ?? '/', 'http://preview')
        } catch {
          return next()
        }
        if (here.pathname !== RELAY_PATH) return next()
        /** @param {number} status @param {Record<string, string>} headers @param {Buffer | string} body */
        const send = (status, headers, body) => {
          res.writeHead(status, {
            ...headers,
            'cache-control': 'no-store',
            // The body is any site's, under that site's content-type, on the preview's
            // origin: opened as a page, a relayed text/html would run its scripts there,
            // and an iframe on any site the person visits can open it (ab_preview is
            // SameSite=None). Both headers only bite a document — fetch() never reads them.
            'content-security-policy': "sandbox; default-src 'none'",
            'x-content-type-options': 'nosniff',
          })
          res.end(body)
        }
        if (req.method !== 'GET') {
          return send(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' }, 'the relay only fetches: use GET')
        }
        const target = here.searchParams.get('url')
        if (!target) {
          return send(400, { 'content-type': 'text/plain; charset=utf-8' }, `usage: ${RELAY_PATH}?url=<encodeURIComponent(absolute URL)>`)
        }
        try {
          // Its refusals come back marked x-ab-relay-error, so one never reads as the site's own answer.
          const out = await viaHost(target, req.headers)
          send(out.status, out.headers, out.body)
        } catch (e) {
          send(502, { 'content-type': 'text/plain; charset=utf-8', 'x-ab-relay-error': '1' }, `relay: apps-builder did not answer: ${/** @type {Error} */ (e).message}`)
        }
      })
    },
  }
}

/**
 * One relayed GET, asked of apps-builder over the line: the browser's FORWARDED headers go out,
 * the status, body and the headers send() passes on come back.
 * @param {string} target
 * @param {http.IncomingHttpHeaders} headers
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 */
async function viaHost(target, headers) {
  /** @type {Record<string, string>} */
  const forwarded = {}
  for (const name of FORWARDED) {
    const value = headers[name]
    if (typeof value === 'string') forwarded[name] = value
  }
  const out = await relayOverLine(target, forwarded)
  /** @type {Record<string, string>} */
  const kept = {}
  for (const name of ['content-type', 'x-ab-final-url', 'x-ab-relay-error']) {
    const value = out.headers[name]
    if (typeof value === 'string') kept[name] = value
  }
  return { status: out.status, headers: kept, body: out.body }
}
