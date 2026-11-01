/**
 * A preview is a Kubernetes Pod: the app's code runs in it, never beside
 * apps-builder. One spec for both ways of running it (backend.ts): rootless podman on the dev server, and the
 * cluster, which adds its own fields (gVisor, no service-account token). The pod has no network — no
 * LAN, no internet, not apps-builder, not another app's pod — and two doors apps-builder alone opens:
 * vite's port, for the dispatcher, check_app and the screenshots; and the control port beside it, which
 * takes the project's files (sync.ts) and carries `/_ab/fetch` out (line.ts). It gets nothing of
 * apps-builder's environment, and its /app is a copy: nothing written there reaches the project.
 *
 * An app is the preview alone until the model asks for more (add_service in tools.ts): a server, run by
 * Bun from the app's server/index.ts and reached at /api on the preview's origin, and Redis or Postgres
 * beside it, their data on one volume at /data. Each runs as locked down as the preview; the databases
 * answer the server, on the pod's localhost.
 */
import { join } from 'node:path'

export const POD_YAML = join('.apps-builder', 'pod.yaml')
/** node + the template's node_modules + the preview scripts (deploy/preview.Dockerfile). */
const IMAGE = Bun.env.AB_PREVIEW_IMAGE ?? 'localhost/apps-builder-preview:dev'
/** Inside the pod: vite, and the control port (preview-control.mjs). */
export const VITE_PORT = 5173
export const CONTROL_PORT = 5174

/** What an app can be given besides its preview. A database brings the server with it. */
export const SERVICES = ['server', 'redis', 'postgres'] as const
export type Service = (typeof SERVICES)[number]
/** Where the server listens, inside the pod; the preview proxies /api to it. */
const SERVER_PORT = 3000
/** Bun for the server: its own Redis and Postgres clients (`redis`, `sql` from 'bun') mean an app
 *  needs no package to use either — and the model cannot install one. */
const BUN_IMAGE = 'docker.io/oven/bun:1.4.2-alpine'
const REDIS_IMAGE = 'docker.io/library/redis:8.4.0-alpine'
const POSTGRES_IMAGE = 'docker.io/library/postgres:18.6-alpine'
/** The image's postgres user: postgres will not run as root, and its data has to be this uid's. */
export const POSTGRES_UID = 70
/** Exits 0 once the server's databases answer. Bun.redis's own client retries for 30 s against
 *  a closed port; this one fails at once, so the loop around it polls. */
const READY =
  'if (process.env.DATABASE_URL) await Bun.sql`select 1`; ' +
  'if (process.env.REDIS_URL) await new Bun.RedisClient(process.env.REDIS_URL, { autoReconnect: false, connectionTimeout: 500 }).ping()'
/**
 * The server, restarted when a file under /app changes. Not `bun --watch`: the files arrive through the
 * preview's container, and under gVisor a write in one container is not signalled to another (measured
 * 2026-10-21). After a crash it waits for a change too, as --watch did. A hash of the files' contents,
 * not `find -newer`: busybox compares whole seconds, and an edit in the second of a restart was missed.
 * ponytail: hashes the project's files (node_modules aside) every 0.5 s; gVisor mount hints (a Talos
 * CRI patch) would bring --watch's 127 ms back.
 */
const RESTART_LOOP =
  'sig() { find /app -path /app/node_modules -prune -o -type f -exec md5sum {} + | md5sum; }; ' +
  'while :; do s=$(sig); bun server/index.ts & pid=$!; ' +
  'while [ "$(sig)" = "$s" ]; do sleep 0.5; done; ' +
  'kill $pid 2>/dev/null; wait $pid; done'
/** Every container's: no capability, no way to gain one, nothing written outside its mounts. */
export const LOCKED = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true }

export type Volume = { name: string } & Record<string, unknown>
export type Container = {
  name: string
  image: string
  imagePullPolicy: string
  command?: string[]
  workingDir?: string
  ports?: { containerPort: number }[]
  env?: { name: string; value: string }[]
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } }
  securityContext: Record<string, unknown>
  volumeMounts: { name: string; mountPath: string; readOnly?: boolean }[]
}
export type Pod = {
  apiVersion: 'v1'
  kind: 'Pod'
  metadata: { name: string; labels: Record<string, string> }
  spec: { restartPolicy: 'Never'; containers: Container[]; volumes: Volume[] } & Record<string, unknown>
}

/**
 * `data`: the databases' volume (backend.ts), mounted at /data in redis and postgres; undefined
 * when the app has neither. `token`: the control port's, in the preview container's environment alone.
 */
export function podSpec(
  name: string,
  labels: Record<string, string>,
  services: readonly Service[],
  token: string,
  data: Volume | undefined,
): Pod {
  const has = (service: Service) => services.includes(service)
  const env = (vars: Record<string, string | false>) =>
    Object.entries(vars).flatMap(([k, v]) => (v === false ? [] : [{ name: k, value: v }]))
  // A /tmp each: the server runs the model's code, and the preview's holds vite's cache.
  const tmp = (name: string) => ({ name, mountPath: '/tmp' })
  const dataMount = { name: 'data', mountPath: '/data' }
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, labels: { 'app.kubernetes.io/managed-by': 'apps-builder', ...labels } },
    spec: {
      // A preview that dies stays dead: apps-builder sees it go (backend.exited), and the next open
      // starts it again.
      restartPolicy: 'Never',
      containers: [
        {
          name: 'preview',
          image: IMAGE,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '/ab/preview-vite.mjs'],
          workingDir: '/app',
          ports: [{ containerPort: VITE_PORT }, { containerPort: CONTROL_PORT }],
          // AB_API: where preview-vite.mjs sends /api, when there is a server to send it to.
          env: env({ AB_CONTROL_TOKEN: token, AB_API: has('server') && `http://127.0.0.1:${SERVER_PORT}` }),
          resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
          securityContext: LOCKED,
          volumeMounts: [{ name: 'app', mountPath: '/app' }, tmp('tmp')],
        },
        ...(has('server')
          ? [
              {
                name: 'server',
                image: BUN_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                // sh as PID 1, because Bun there ignores SIGTERM and every stop would wait out the
                // grace period. It waits for server/index.ts — the model adds the server before
                // writing it — and for its databases to answer: every container starts at once, and a
                // server that makes its tables as it loads failed against a Postgres still starting
                // (dev, 2026-10-03). Then RESTART_LOOP.
                command: [
                  'sh',
                  '-c',
                  `trap "exit 0" TERM; until [ -f server/index.ts ]; do sleep 1; done; until bun -e '${READY}' >/dev/null 2>&1; do sleep 0.5; done; ${RESTART_LOOP} & wait`,
                ],
                workingDir: '/app',
                env: env({
                  PORT: String(SERVER_PORT),
                  REDIS_URL: has('redis') && 'redis://127.0.0.1:6379',
                  DATABASE_URL: has('postgres') && 'postgres://postgres@127.0.0.1:5432/postgres',
                }),
                resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
                securityContext: LOCKED,
                // Read-only: it runs the model's code, which keeps its data in the databases.
                volumeMounts: [{ name: 'app', mountPath: '/app', readOnly: true }, tmp('server-tmp')],
              },
            ]
          : []),
        ...(has('redis')
          ? [
              {
                name: 'redis',
                image: REDIS_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                // The image's entrypoint is skipped: it chowns /data, which needs a capability.
                command: ['sh', '-c', 'mkdir -p /data/redis && exec redis-server --bind 127.0.0.1 --appendonly yes --dir /data/redis --maxmemory 100mb'],
                resources: { requests: { cpu: '25m', memory: '32Mi' }, limits: { cpu: '250m', memory: '128Mi' } },
                securityContext: LOCKED,
                volumeMounts: [dataMount],
              },
            ]
          : []),
        ...(has('postgres')
          ? [
              {
                name: 'postgres',
                image: POSTGRES_IMAGE,
                imagePullPolicy: 'IfNotPresent',
                // The entrypoint is skipped here too (it chowns, and wants a socket under a read-only
                // /var/run): initdb once, then postgres on localhost alone, trusting it — nothing
                // outside the pod can reach the port.
                command: [
                  'sh',
                  '-c',
                  'test -s "$PGDATA/PG_VERSION" || initdb --username=postgres --auth=trust >/dev/null; ' +
                    'exec postgres -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c shared_buffers=32MB',
                ],
                env: env({ PGDATA: '/data/postgres' }),
                resources: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '500m', memory: '256Mi' } },
                securityContext: { ...LOCKED, runAsUser: POSTGRES_UID, runAsGroup: POSTGRES_UID },
                volumeMounts: [dataMount, tmp('postgres-tmp')],
              },
            ]
          : []),
      ],
      volumes: [
        { name: 'app', emptyDir: { sizeLimit: '256Mi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
        ...(has('server') ? [{ name: 'server-tmp', emptyDir: { sizeLimit: '64Mi' } }] : []),
        ...(has('postgres') ? [{ name: 'postgres-tmp', emptyDir: { sizeLimit: '64Mi' } }] : []),
        ...(data ? [{ ...data, name: 'data' }] : []),
      ],
    },
  }
}
