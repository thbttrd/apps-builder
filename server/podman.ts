/**
 * The preview's pod under rootless podman (`podman kube play`), on the dev server. What is podman's and not
 * Kubernetes': this tree's preview scripts mounted over the image's (dev runs the working tree), the
 * two ports published on 127.0.0.1, a network of its own, and the databases' data in a directory beside
 * the projects (.data/<slug>), never in the app's git.
 */
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { Backend } from './backend'
import { CONTROL_PORT, POSTGRES_UID, type Pod, VITE_PORT } from './pod'

const SCRIPTS = ['preview-vite.mjs', 'preview-control.mjs', 'fetch-relay.mjs', 'crash-overlay.mjs']

export function makePodman(instance: string, dataRoot: string): Backend {
  const dataDir = (slug: string) => join(dataRoot, slug)
  return {
    /**
     * Each pod on a network of its own, named and labelled as the pod: `--internal`, a bridge with no
     * route out. Not one bridge for all — pods on one bridge reach each other, vite listens on all of
     * the pod's addresses, and a server runs the model's code. `--replace`: a pod a crash left under
     * this name goes first.
     */
    async run(spec) {
      const { name, labels } = spec.metadata
      const labelled = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`])
      await podman(['network', 'create', '--ignore', '--internal', ...labelled, name])
      // /app starts empty: a volume a crash left under this name goes first.
      await podman(['volume', 'rm', '--force', appVolume(name)], true)
      const vite = freePort()
      const control = freePort()
      // On stdin: the spec carries the control token, which never touches the disk.
      await podman(
        [
          'kube', 'play', '--replace', '--network', name,
          '--publish', `127.0.0.1:${vite}:${VITE_PORT}`, '--publish', `127.0.0.1:${control}:${CONTROL_PORT}`,
          '-',
        ],
        false,
        Bun.YAML.stringify(forPodman(spec), null, 2),
      )
      return { vite: `http://127.0.0.1:${vite}`, control: `http://127.0.0.1:${control}` }
    },

    async remove(name) {
      await podman(['pod', 'rm', '--force', '--ignore', '--time', '2', name], true)
      await podman(['volume', 'rm', '--force', appVolume(name)], true)
      await podman(['network', 'rm', name], true)
    },

    async removeAll() {
      const label = `apps-builder/instance=${instance}`
      const listed = Bun.spawn(['podman', 'pod', 'ps', '--quiet', '--filter', `label=${label}`], { stdout: 'pipe', stderr: 'ignore' })
      const ids = (await new Response(listed.stdout).text()).split('\n').filter(Boolean)
      if (ids.length) await podman(['pod', 'rm', '--force', '--ignore', '--time', '1', ...ids], true)
      // Pods are named ab-<instance>-<slug> (previews.ts), and so are their /app volumes.
      const volumes = Bun.spawn(['podman', 'volume', 'ls', '--quiet', '--filter', `name=^ab-${instance}-.*-app$`], { stdout: 'pipe', stderr: 'ignore' })
      const names = (await new Response(volumes.stdout).text()).split('\n').filter(Boolean)
      if (names.length) await podman(['volume', 'rm', '--force', ...names], true)
      // Unused ones only, so after the pods: a network goes when nothing is on it.
      await podman(['network', 'prune', '--force', '--filter', `label=${label}`], true)
    },

    /** ponytail: one `podman wait` (~51 MB) per running preview; one `podman events` stream for all if that adds up. */
    async exited(name) {
      await Bun.spawn(['podman', 'wait', `${name}-preview`], { stdout: 'ignore', stderr: 'ignore' }).exited
    },

    async logs(name, container) {
      const p = Bun.spawn(['podman', 'logs', '--tail', '20', `${name}-${container}`], { stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      return `${out}${err}`.trim()
    },

    /**
     * .data/<slug>, with redis/ and postgres/ made before the pod mounts it. Postgres's is handed to its
     * uid as the pod sees it — a subordinate uid on the host, which only `podman unshare` can give it to.
     */
    async dataVolume(slug, _dataId, services) {
      if (!services.includes('redis') && !services.includes('postgres')) return undefined
      const dir = dataDir(slug)
      await mkdir(join(dir, 'redis'), { recursive: true })
      if (services.includes('postgres')) {
        await mkdir(join(dir, 'postgres'), { recursive: true })
        await podman(['unshare', 'chown', `${POSTGRES_UID}:${POSTGRES_UID}`, join(dir, 'postgres')])
      }
      return { name: 'data', hostPath: { path: dir, type: 'Directory' } }
    },

    /** Through `podman unshare`, since Postgres's files are not this user's. */
    async removeData(slug) {
      await podman(['unshare', 'rm', '-rf', dataDir(slug)])
    },

    async renameData(from, to) {
      await rename(dataDir(from), dataDir(to)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e
      })
    },
  }
}

/**
 * The spec as podman runs it:
 * - the working tree's preview scripts, read-only over the image's: dev and the check suite run them;
 * - the preview as uid 0, which rootless podman maps to this user, as before the cluster backend: podman makes a
 *   shared emptyDir root's, and the image's uid 1000 could not write the /app it shares with a server;
 * - no /tmp volumes: podman gives a read-only container a tmpfs /tmp of its own (the cluster has none);
 * - /app's volume named after the pod: podman turns a kube emptyDir into a named volume, named as the
 *   spec names it, so every pod's `app` was one volume and each preview's files landed in every other's
 *   /app (found 2026-10-21).
 */
function forPodman(spec: Pod): Pod {
  const tmp = new Set(['tmp', 'server-tmp', 'postgres-tmp'])
  const app = appVolume(spec.metadata.name)
  const renamed = <T extends { name: string }>(v: T): T => (v.name === 'app' ? { ...v, name: app } : v)
  const mounts = SCRIPTS.map((file) => ({ name: file.replace('.mjs', ''), mountPath: `/ab/${file}`, readOnly: true }))
  const volumes = SCRIPTS.map((file) => ({ name: file.replace('.mjs', ''), hostPath: { path: join(import.meta.dir, file), type: 'File' } }))
  const containers = spec.spec.containers.map((c) => ({
    ...c,
    volumeMounts: [...c.volumeMounts.filter((m) => !tmp.has(m.name)).map(renamed), ...(c.name === 'preview' ? mounts : [])],
    ...(c.name === 'preview' ? { securityContext: { ...c.securityContext, runAsUser: 0, runAsGroup: 0 } } : {}),
  }))
  return {
    ...spec,
    spec: { ...spec.spec, containers, volumes: [...spec.spec.volumes.filter((v) => !tmp.has(v.name)).map(renamed), ...volumes] },
  }
}

const appVolume = (pod: string) => `${pod}-app`

/**
 * A free port on 127.0.0.1, by binding :0 and letting go.
 * ponytail: another process can take it between here and --publish; play then fails and the open is
 * retried by hand. Retry on EADDRINUSE if that is ever seen.
 */
function freePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  return port
}

/** Exit code when `quiet`; otherwise throws with podman's own words. `input` goes to its stdin. */
async function podman(args: string[], quiet = false, input?: string): Promise<number> {
  const p = Bun.spawn(['podman', ...args], { stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'ignore', stderr: 'pipe' })
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  if (code !== 0 && !quiet) throw new Error(`podman ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim()}`)
  return code
}
