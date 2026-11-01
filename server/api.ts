/**
 * apps-builder's server: the UI and its API on :8787 (routes.ts) and the preview dispatcher on
 * :8788 (dispatch.ts), each behind gate(); and the pods, stopped before anything is served and
 * again on the way out.
 */
import { type HmrPipe, dispatch, websocket } from './dispatch'
import { ORIGIN_HEADER, refused } from './origin'
import { running } from './agent'
import { reapIdle, stopAll } from './previews'
import { app } from './routes'
import { GIT_SHA } from './version'

const PORT = Number(Bun.env.PORT ?? 8787)
const PREVIEW_PORT = Number(Bun.env.PREVIEW_PORT ?? 8788)
const ORIGIN_SECRET = Bun.env.AB_ORIGIN_SECRET

/** First thing on both ports, ahead of Hono and of the websocket branch alike (origin.ts). */
function gate(req: Request): Response | undefined {
  const status = refused(ORIGIN_SECRET, req.headers.get(ORIGIN_HEADER))
  return status ? new Response(null, { status }) : undefined
}

// Pods outlive this process: whatever this instance left running when it was last killed —
// a `bun --watch` restart, a crash — goes before anything is served. Said, not fatal, when it can't: a
// leftover pod is replaced by name at its next start anyway, and the UI still serves.
await stopAll().catch((e) => console.error('[boot] leftover previews not removed:', (e as Error).message))
// A preview nobody uses is stopped after a while (previews.ts IDLE_MS): the cluster's quota is 8 running.
setInterval(() => void reapIdle(running), 60_000)

Bun.serve({ port: PORT, fetch: (req, server) => gate(req) ?? app.fetch(req, server), idleTimeout: 120 })

Bun.serve<HmrPipe>({
  port: PREVIEW_PORT,
  idleTimeout: 120,
  fetch: (req, server) => gate(req) ?? dispatch(req, server),
  websocket,
})

// For systemd's stop, `bun run dev` and Ctrl-C: the pods are not in this process's cgroup.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await stopAll().catch((e) => console.error('[stop]', (e as Error).message))
    process.exit(0)
  })
}

console.log(`apps-builder ${GIT_SHA} — ui :${PORT} · preview dispatcher :${PREVIEW_PORT}`)
