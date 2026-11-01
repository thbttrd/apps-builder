import type { IncomingHttpHeaders, Server } from 'node:http'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { ORIGIN_HEADER, refused } from './server/origin.ts'

// base stays '/' on purpose: previews get their own hostname, never a path prefix.
// See the private design log — path-prefix proxying breaks origin isolation five different ways.
export default defineConfig(({ mode }) => {
  // loadEnv, not process.env: `vite` is spawned as a sibling of the API by `bun run dev`,
  // and relying on the parent to have exported .env is how the proxy silently points at
  // the wrong server. This reads the file itself.
  const env = loadEnv(mode, process.cwd(), '')

  // The API port is a variable because dev and staging run side by side on one box, and
  // the old hardcoded 8787 meant starting dev killed whichever one got there second.
  const apiPort = env.PORT || '8787'

  // Set only on the box that serves apps-builder.dev.example.net. Unset — the normal case,
  // including a laptop — leaves vite on localhost with its default same-origin HMR.
  const devHost = env.AB_DEV_HOST

  // Every request must carry the X-Origin-Auth the SSO proxy stamps after SSO (server/origin.ts),
  // the same gate the API applies. Registered in the hook itself, not a returned post-hook,
  // so it runs before the /api proxy and /__open-in-editor. The HMR socket never reaches
  // connect middlewares, and vite's own token check passes any upgrade without an Origin,
  // hence the upgrade listener, prepended so it runs before vite's.
  const status = (h: IncomingHttpHeaders) => refused(env.AB_ORIGIN_SECRET, String(h[ORIGIN_HEADER] ?? ''))
  const originGate: Plugin = {
    name: 'origin-gate',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const refusal = status(req.headers)
        if (!refusal) return next()
        res.statusCode = refusal
        res.end()
      })
      const http = server.httpServer as Server | null
      http?.prependListener('upgrade', (req, socket) => {
        if (status(req.headers)) socket.destroy()
      })
    },
  }

  return {
    plugins: [react(), tailwindcss(), originGate],
    build: { outDir: 'dist/client', emptyOutDir: true },
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: { '/api': `http://127.0.0.1:${apiPort}` },
      ...(devHost && {
        // Traefik reaches this from the proxy, so localhost-only is not enough. ufw scopes the
        // port to 192.168.100.43, but containers and the VPN bypass ufw: originGate is
        // the actual boundary.
        host: true,
        allowedHosts: [devHost],
        // Without this the HMR client dials ws://<host>:5173 from the browser and hangs:
        // the page is served over TLS on 443 and 5173 is not open to the world.
        hmr: { protocol: 'wss', host: devHost, clientPort: 443 },
      }),
    },
  }
})
