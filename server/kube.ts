/**
 * The preview's pod on the cluster: Pods and the databases' PVCs in one preview
 * namespace, made over the API server's HTTPS with apps-builder's service-account token. A handful of
 * verbs and one watch: plain fetch, no client library.
 *
 * What is the cluster's and not podman's: gVisor, no service-account token and no service links in the
 * pod, a non-root pod with fsGroup (the emptyDirs and the PVC become its group's), the pod's own IP as
 * its address (the platform admits this apps-builder to ports 5173 and 5174 of its previews, nothing
 * else), and the databases on a PVC named by the project's dataId, which a rename does not touch.
 */
import type { Backend } from './backend'
import { CONTROL_PORT, type Pod, VITE_PORT } from './pod'
import { HttpError } from './project'

/** What a start the namespace's ResourceQuota refuses tells the person: 503, not 409, which createUnique
 *  reads as a name already taken. */
export const QUOTA_FULL = "the cluster's preview quota is full: stop a running preview, then start this one"
/** A database volume lives as long as its project: stopping previews frees none. */
export const VOLUMES_FULL = "the cluster has no room for another app's database: delete an app that has one, then start this one"

type Status = { code?: number; message?: string }
type PodState = {
  metadata: { name: string; labels?: Record<string, string>; deletionTimestamp?: string }
  spec?: { nodeName?: string; volumes?: { persistentVolumeClaim?: unknown }[] }
  status?: {
    phase?: string
    podIP?: string
    conditions?: { type: string; status: string; message?: string }[]
    containerStatuses?: { name: string; state?: { terminated?: unknown; waiting?: { reason?: string; message?: string } } }[]
  }
}

/** The API's words in a message, whole up to a point: an image pull's error can run to kilobytes. */
const cap = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text)

/**
 * What holds a pod short of running, in the cluster's words: the scheduler's (no node with room), a
 * container's wait (ContainerCreating, ImagePullBackOff), else its phase. From the pod itself: no events
 * call, no verb the Role lacks.
 */
function why(pod: PodState): string {
  const unscheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False')?.message
  const waiting = pod.status?.containerStatuses?.map((c) => c.state?.waiting).find((w) => w?.reason)
  return cap(unscheduled ?? (waiting ? [waiting.reason, waiting.message].filter(Boolean).join(': ') : (pod.status?.phase ?? 'not scheduled yet').toLowerCase()))
}

/**
 * A preview is over when its pod has ended, is being deleted (on a node that is down it stays Terminating
 * for good), or its preview container has ended while the server or a database runs on: with restartPolicy
 * Never the pod's phase waits for every container.
 */
const ended = (pod: PodState) =>
  pod.status?.phase === 'Succeeded' ||
  pod.status?.phase === 'Failed' ||
  pod.metadata.deletionTimestamp !== undefined ||
  pod.status?.containerStatuses?.some((c) => c.name === 'preview' && c.state?.terminated) === true

/** `timeouts` is for the tests. */
export function makeKube(
  api: string,
  token: () => string,
  ca: string | undefined,
  namespace: string,
  instance: string,
  timeouts = { running: 30_000, gone: 30_000 },
): Backend {
  const base = `${api}/api/v1/namespaces/${namespace}`
  const selector = `apps-builder/instance=${instance}`
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...init.headers },
      ...(ca ? { tls: { ca } } : {}),
    } as RequestInit)
  /** The response, or a throw with the API's own words; a quota refusal as `full`, for the person. */
  const ok = async (r: Response, what: string, full = QUOTA_FULL) => {
    if (r.ok) return r
    const s = (await r.json().catch(() => ({}))) as Status
    if (r.status === 403 && s.message?.includes('exceeded quota')) throw new HttpError(503, full)
    throw new Error(`${what}: ${r.status} ${cap(s.message ?? '')}`.trim())
  }

  // One watch for the whole process: a pod's waiters resolve when it ends (Succeeded, Failed) or goes.
  const waiters = new Map<string, (() => void)[]>()
  let watching = false
  const settle = (name: string) => {
    for (const w of waiters.get(name) ?? []) w()
    waiters.delete(name)
  }
  const watch = async () => {
    for (;;) {
      try {
        // A list first: whatever ended or went while no watch was open settles its waiters now.
        const list = (await (await ok(await call(`/pods?labelSelector=${encodeURIComponent(selector)}`), 'list pods')).json()) as {
          items: PodState[]
          metadata: { resourceVersion: string }
        }
        const alive = new Set(list.items.filter((p) => !ended(p)).map((p) => p.metadata.name))
        for (const name of [...waiters.keys()]) if (!alive.has(name)) settle(name)
        const r = await ok(
          await call(`/pods?labelSelector=${encodeURIComponent(selector)}&watch=1&resourceVersion=${list.metadata.resourceVersion}`),
          'watch pods',
        )
        let rest = ''
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          rest += new TextDecoder().decode(chunk)
          const lines = rest.split('\n')
          rest = lines.pop() ?? ''
          for (const line of lines.filter(Boolean)) {
            const { type, object } = JSON.parse(line) as { type: string; object: PodState }
            if (type === 'DELETED' || ended(object)) settle(object.metadata.name)
          }
        }
      } catch (e) {
        console.error('[kube watch]', (e as Error).message)
      }
      await Bun.sleep(1000)
    }
  }

  const get = async (name: string) => {
    const r = await call(`/pods/${name}`)
    return r.status === 404 ? undefined : ((await (await ok(r, `get ${name}`)).json()) as PodState)
  }
  const remove = async (name: string) => {
    const del = async (gracePeriodSeconds: number) => {
      const r = await call(`/pods/${name}`, { method: 'DELETE', body: JSON.stringify({ gracePeriodSeconds }) })
      if (r.status !== 404) await ok(r, `delete ${name}`)
    }
    await del(2)
    let deadline = Date.now() + timeouts.gone
    let forced = false
    for (let pod = await get(name); pod; pod = await get(name)) {
      if (Date.now() > deadline) {
        // Never "removed" while it still holds its volume: a rename's next start would then meet a Multi-Attach,
        // or a second postgres on one PGDATA once a partitioned node came back. On a node that is down a pod
        // stays Terminating for good, and its project with it: one without a database (its /app an emptyDir)
        // is forced from the API, once.
        if (forced || pod.spec?.volumes?.some((v) => v.persistentVolumeClaim)) {
          const node = pod.spec?.nodeName
          throw new Error(`the preview's pod ${name} is still terminating${node ? ` on ${node} (is the node down?)` : ''}`)
        }
        forced = true
        await del(0)
        deadline = Date.now() + timeouts.gone
      }
      await Bun.sleep(250)
    }
  }

  return {
    async run(spec) {
      const pod = forCluster(spec)
      const name = pod.metadata.name
      let r = await call('/pods', { method: 'POST', body: JSON.stringify(pod) })
      if (r.status === 409) {
        // A pod a crash left under this name goes first, as podman's --replace does.
        await remove(name)
        r = await call('/pods', { method: 'POST', body: JSON.stringify(pod) })
      }
      await ok(r, `create ${name}`)
      // The databases' PVC once the pod is admitted: a start the quota refuses leaves none behind.
      const claim = pod.spec.volumes.find((v) => v.name === 'data')?.persistentVolumeClaim as { claimName: string } | undefined
      if (claim) {
        const made = await call('/persistentvolumeclaims', { method: 'POST', body: JSON.stringify(pvcFor(claim.claimName, pod.metadata.labels)) })
        if (made.status !== 409) await ok(made, `create ${claim.claimName}`, VOLUMES_FULL).catch(async (e) => {
          // The pod goes too; if it can't, the person still reads why the start failed.
          await remove(name).catch((r: Error) => console.error(`[kube ${name}] its PVC refused, the pod not removed:`, r.message))
          throw e
        })
      }
      const deadline = Date.now() + timeouts.running
      for (;;) {
        const now = await get(name)
        if (!now || ended(now)) throw new Error(`the preview's pod ${now ? now.status?.phase?.toLowerCase() : 'went'} before running`)
        if (now.status?.phase === 'Running' && now.status.podIP) {
          return { vite: `http://${now.status.podIP}:${VITE_PORT}`, control: `http://${now.status.podIP}:${CONTROL_PORT}` }
        }
        if (Date.now() > deadline) throw new Error(`the preview's pod was not running within ${timeouts.running / 1000}s: ${why(now)}`)
        await Bun.sleep(250)
      }
    },

    remove,

    async removeAll() {
      const r = await ok(await call(`/pods?labelSelector=${encodeURIComponent(selector)}`), 'list pods')
      const { items } = (await r.json()) as { items: PodState[] }
      await Promise.all(items.map((p) => remove(p.metadata.name)))
    },

    exited(name) {
      if (!watching) {
        watching = true
        void watch()
      }
      return new Promise<void>((resolve) => waiters.set(name, [...(waiters.get(name) ?? []), resolve]))
    },

    async logs(name, container) {
      const r = await call(`/pods/${name}/log?container=${container}&tailLines=20`).catch(() => undefined)
      return r?.ok ? (await r.text()).trim() : ''
    },

    /** The PVC's name only: run() makes it, once the pod is admitted. */
    async dataVolume(_slug, dataId, services) {
      if (!services.includes('redis') && !services.includes('postgres')) return undefined
      if (!dataId) throw new Error("this app's databases have no dataId (project.json)")
      return { name: 'data', persistentVolumeClaim: { claimName: `data-${dataId}` } }
    },

    async removeData(_slug, dataId) {
      if (!dataId) return
      const r = await call(`/persistentvolumeclaims/data-${dataId}`, { method: 'DELETE' })
      if (r.status !== 404) await ok(r, `delete data-${dataId}`)
    },

    /** The PVC is named by the dataId, which a rename keeps. */
    async renameData() {},
  }
}

/** The spec as the cluster runs it: gVisor, no token, no service links, non-root with fsGroup. */
function forCluster(spec: Pod): Pod {
  return {
    ...spec,
    spec: {
      ...spec.spec,
      runtimeClassName: 'gvisor',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // OnRootMismatch: a re-chown at every start would leave PGDATA group-readable, which postgres refuses.
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: 'OnRootMismatch',
        seccompProfile: { type: 'RuntimeDefault' },
      },
    },
  }
}

/** One replica on the pod's node, deleted with the claim, backed up nightly. */
function pvcFor(name: string, labels: Record<string, string>) {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name,
      labels: {
        ...labels,
        'recurring-job.longhorn.io/source': 'enabled',
        'recurring-job-group.longhorn.io/backup': 'enabled',
      },
    },
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'longhorn-local', resources: { requests: { storage: '1Gi' } } },
  }
}
