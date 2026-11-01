// @ts-check
/**
 * A preview's dev server: what `node node_modules/vite/bin/vite.js` does, plus apps-builder's
 * own plugins. Run as the command of the preview's pod (pod.ts), the project mounted as cwd.
 *
 * The plugins go in as inline config, which vite merges over the project's vite.config.ts
 * the way it merges CLI flags — so every project has them, the ones created before they
 * existed included, and nothing the agent writes into vite.config.ts can take them out.
 *
 * The project's own vite, resolved from its cwd: the one its lockfile pinned, exactly as
 * the CLI would have run it. Its banner goes to the pod's log.
 *
 * All interfaces on a fixed port: the pod is its own network, and podman publishes this port
 * on the host's 127.0.0.1 under whatever port startPreview picked (pod.ts, VITE_PORT).
 */
import { existsSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { crashOverlay } from './crash-overlay.mjs'
import { fetchRelay } from './fetch-relay.mjs'
import { startControl } from './preview-control.mjs'

// The image's node_modules (deploy/preview.Dockerfile): a project pushed into an empty /app has none
// of its own. A project mounted with its own (podman, before the cluster backend) keeps it.
if (!existsSync('node_modules') && existsSync('/ab/node_modules')) symlinkSync('/ab/node_modules', 'node_modules')

// Set by pod.ts when the app has a server: /api goes to it, websockets included, so the app
// and check_app reach it on the preview's own origin.
const api = process.env.AB_API

// The control port first (preview-control.mjs): /app is empty until apps-builder's first push, and vite
// starts once it has landed.
const token = process.env.AB_CONTROL_TOKEN
if (!token) {
  console.error('AB_CONTROL_TOKEN is not set: apps-builder gives every preview pod one (pod.ts)')
  process.exit(1)
}
startControl({ root: process.cwd(), token, port: 5174, onFirstPush: () => void startVite() })

async function startVite() {
  try {
    const require = createRequire(join(process.cwd(), 'package.json'))
    /** @type {typeof import('vite')} */
    const vite = await import(pathToFileURL(require.resolve('vite')).href)
    const server = await vite.createServer({
      server: {
        host: '0.0.0.0',
        port: 5173,
        strictPort: true,
        // apps-builder's own files, not the app's. A turn rewrites chat.json and project.json after
        // every step, and Tailwind's vite plugin, which scans every file git keeps for class names,
        // answered each write with a full reload of the page: the preview reloaded at every step of
        // every turn (@tailwindcss/vite 4.3, measured 2026-10-09).
        watch: { ignored: ['**/.apps-builder/**'] },
        ...(api ? { proxy: { '/api': { target: api, ws: true } } } : {}),
        // The project, the image's node_modules (the link resolves to /ab) and the cache: vite serves
        // nothing else.
        fs: { allow: ['/app', '/ab', '/tmp/vite'] },
      },
      // Not node_modules/.vite: the image's node_modules is read-only. /tmp is the pod's emptyDir.
      cacheDir: '/tmp/vite',
      // The project's vite.config.ts through vite's module runner: the default bundles it to a file under
      // node_modules/.vite-temp, which the image's read-only node_modules refuses.
      configLoader: 'runner',
      plugins: [fetchRelay(), crashOverlay()],
      // An inline PostCSS config, so Vite never looks for one: a postcss.config.*, a .postcssrc
      // or a "postcss" key in package.json would be code the model wrote, run by this process.
      css: { postcss: {} },
    })
    await server.listen()
    server.printUrls()
  } catch (e) {
    console.error('error when starting dev server:', e)
    process.exit(1)
  }
}

// As the pod's PID 1, node gets no default handler for SIGTERM: without this, every stop
// waits out podman's grace period and ends in a SIGKILL.
process.on('SIGTERM', () => process.exit(0))
