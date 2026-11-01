/**
 * :8788, the preview dispatcher, reached only from the proxy's Traefik: each preview's page by the
 * first label of its host, the cookie Traefik's forwardAuth checks, and vite's HMR socket.
 */
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { addressOf, viewing } from './previews'
import { GATEWAY_HEADER, ORIGIN_HEADER, matches } from './origin'

/** The preview cookie's value: POST /api/session hands it out (routes.ts), /_ab/auth checks it. */
export const PREVIEW_SECRET = Bun.env.AB_PREVIEW_SECRET ?? ''

/** Previews are addressed by the first label of the Host header: <slug>.preview.<domain>. */
function slugOf(req: Request): string {
  return (req.headers.get('host') ?? '').split('.')[0] ?? ''
}

const preview = new Hono()

// Traefik forwardAuth calls this for every preview request. It must be fast and it
// must fail closed: a 401 here is the only thing standing between a generated app
// and the public internet.
preview.get('/_ab/auth', (c) =>
  matches(getCookie(c, 'ab_preview'), PREVIEW_SECRET) ? c.body(null, 200) : c.body(null, 401),
)

/**
 * The Cookie header without ab_preview: it opens every preview, and the app's own code — its server
 * behind vite's /api proxy — could send it anywhere through the relay. The app's own cookies stay.
 */
function withoutPreviewCookie(cookie: string): string {
  return cookie
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('ab_preview='))
    .join('; ')
}

preview.all('*', (c) => {
  // The dispatcher asks for the cookie itself, as forwardAuth's /_ab/auth does: on the cluster nothing
  // in front of it does. 401, never a page, without it.
  if (!matches(getCookie(c, 'ab_preview'), PREVIEW_SECRET)) return c.body(null, 401)
  const slug = slugOf(c.req.raw)
  const address = addressOf(slug)
  if (!address) return c.text(`no preview running for "${slug}"`, 503)
  const url = new URL(c.req.url)
  const vite = new URL(address.vite)
  url.protocol = vite.protocol
  url.host = vite.host
  // redirect: 'manual' so a 30x from the preview reaches the browser as a 30x. The
  // default follows it here and hands the body back under the original URL with a 200 —
  // relative links then resolve against the wrong path and the address bar never moves.
  // Vite redirects only when `base` !== '/', but an app's own server (add_service, behind
  // vite's /api proxy) answers whatever it likes.
  const forwarded = new Request(url, c.req.raw)
  // Dropped so a generated app never sees the proxy's stamps or the preview cookie: its pod has no network,
  // but the relay reaches any public site, and each opens these ports to whoever holds it.
  forwarded.headers.delete(ORIGIN_HEADER)
  forwarded.headers.delete(GATEWAY_HEADER)
  const cookie = withoutPreviewCookie(forwarded.headers.get('cookie') ?? '')
  if (cookie) forwarded.headers.set('cookie', cookie)
  else forwarded.headers.delete('cookie')
  return fetch(forwarded, { redirect: 'manual' })
})

/** One browser websocket piped to one vite websocket. */
export type HmrPipe = {
  /** The preview's, counted as viewed while the socket is open (reapIdle). */
  slug: string
  target: string
  protocol: string
  upstream?: WebSocket
  /** Frames that arrived before vite's socket opened. Dropping them loses HMR events. */
  queue: (string | Buffer)[]
}

/** A request gate() let through: a preview's page, or its HMR socket handed to `websocket`. */
export function dispatch(req: Request, server: Bun.Server<HmrPipe>): Response | Promise<Response> | undefined {
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return preview.fetch(req)

  // Vite's HMR socket. A plain fetch() proxy cannot carry an upgrade, and getting the
  // subprotocol wrong fails *silently* — the page renders and HMR simply never fires.
  const cookie = (req.headers.get('cookie') ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('ab_preview='))
  if (!matches(cookie?.slice('ab_preview='.length), PREVIEW_SECRET)) return new Response(null, { status: 401 })
  const slug = slugOf(req)
  const address = addressOf(slug)
  if (!address) return new Response('no preview running', { status: 503 })
  const url = new URL(req.url)
  const protocol = (req.headers.get('sec-websocket-protocol') ?? '').split(',')[0]?.trim() ?? ''
  const upgraded = server.upgrade(req, {
    data: { slug, target: `${address.vite.replace(/^http/, 'ws')}${url.pathname}${url.search}`, protocol, queue: [] },
    headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined,
  })
  return upgraded ? undefined : new Response('upgrade failed', { status: 400 })
}

export const websocket: Bun.WebSocketHandler<HmrPipe> = {
  open(ws) {
    viewing(ws.data.slug, 1)
    const upstream = new WebSocket(ws.data.target, ws.data.protocol ? [ws.data.protocol] : [])
    upstream.binaryType = 'arraybuffer'
    ws.data.upstream = upstream
    upstream.onopen = () => {
      for (const frame of ws.data.queue) upstream.send(frame)
      ws.data.queue.length = 0
    }
    upstream.onmessage = (e) =>
      ws.send(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
    upstream.onclose = () => ws.close()
    upstream.onerror = () => ws.close()
  },
  message(ws, frame) {
    const upstream = ws.data.upstream
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame)
    else ws.data.queue.push(frame)
  },
  close(ws) {
    viewing(ws.data.slug, -1)
    ws.data.upstream?.close()
  },
}
