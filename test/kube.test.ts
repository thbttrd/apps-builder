/**
 * The cluster backend: previews as Pods, and their databases as PVCs, in the
 * preview namespace, over the API server's HTTPS with apps-builder's service-account token. Here against
 * a fake API that keeps pods and PVCs in maps, starts a pod 50 ms after it is created, and streams
 * watch events.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { QUOTA_FULL, VOLUMES_FULL, makeKube } from '../server/kube'
import { type Pod, podSpec } from '../server/pod'
import { HttpError } from '../server/project'
import { TMP } from './fixtures'

const NS = 'previews'
const INSTANCE = 'abc123'
type Stored = Pod & { status?: { phase: string; podIP?: string } }
const pods = new Map<string, Stored>()
const pvcs = new Map<string, { metadata: { name: string; labels: Record<string, string> }; spec: Record<string, unknown> }>()
const auths: string[] = []
const watchers = new Set<ReadableStreamDefaultController<Uint8Array>>()
let quotaFull = false
let volumesFull = false
/** DELETE marks the pod deleted, and it never goes (a node that is down) — unless forced, gracePeriodSeconds 0. */
let stuck = false
/** New pods stay Pending, as the scheduler leaves a pod no node has room for. */
let unschedulable = false
let ip = 10

const event = (type: string, pod: Stored) => {
  for (const w of watchers) w.enqueue(new TextEncoder().encode(`${JSON.stringify({ type, object: pod })}\n`))
}
const status = (code: number, message: string) => Response.json({ kind: 'Status', code, message }, { status: code })
const api = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    auths.push(req.headers.get('authorization') ?? '')
    const url = new URL(req.url)
    const base = `/api/v1/namespaces/${NS}`
    const name = decodeURIComponent(url.pathname.split('/')[6] ?? '')
    if (url.pathname === `${base}/pods` && req.method === 'POST') {
      const pod = (await req.json()) as Stored
      if (quotaFull) return status(403, `pods "${pod.metadata.name}" is forbidden: exceeded quota: previews, requested: pods=1, used: pods=8, limited: pods=8`)
      if (pods.has(pod.metadata.name)) return status(409, 'already exists')
      pod.status = { phase: 'Pending' }
      pods.set(pod.metadata.name, pod)
      if (unschedulable) {
        Object.assign(pod.status, { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient memory.' }] })
        return Response.json(pod, { status: 201 })
      }
      setTimeout(() => {
        pod.status = { phase: 'Running', podIP: `10.0.0.${ip++}` }
        ;(pod.spec as Record<string, unknown>).nodeName = 'node-1'
        event('MODIFIED', pod)
      }, 50)
      return Response.json(pod, { status: 201 })
    }
    if (url.pathname === `${base}/pods` && req.method === 'GET') {
      const selected = [...pods.values()].filter((p) => p.metadata.labels['apps-builder/instance'] === url.searchParams.get('labelSelector')?.split('=')[1])
      if (url.searchParams.get('watch') !== '1') return Response.json({ items: selected, metadata: { resourceVersion: '1' } })
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => void watchers.add(c),
          cancel: () => watchers.clear(),
        }),
      )
    }
    if (url.pathname.endsWith('/log')) return new Response(`last line of ${url.searchParams.get('container')}`)
    if (url.pathname === `${base}/pods/${name}` && req.method === 'GET') return pods.has(name) ? Response.json(pods.get(name)) : status(404, 'not found')
    if (url.pathname === `${base}/pods/${name}` && req.method === 'DELETE') {
      const pod = pods.get(name)
      if (!pod) return status(404, 'not found')
      if (stuck && ((await req.json().catch(() => ({}))) as { gracePeriodSeconds?: number }).gracePeriodSeconds !== 0) return Response.json(pod)
      pods.delete(name)
      event('DELETED', pod)
      return Response.json(pod)
    }
    if (url.pathname === `${base}/persistentvolumeclaims` && req.method === 'POST') {
      const pvc = (await req.json()) as typeof pvcs extends Map<string, infer V> ? V : never
      if (volumesFull) return status(403, `persistentvolumeclaims "${pvc.metadata.name}" is forbidden: exceeded quota: previews, requested: persistentvolumeclaims=1, used: persistentvolumeclaims=8, limited: persistentvolumeclaims=8`)
      if (pvcs.has(pvc.metadata.name)) return status(409, 'already exists')
      pvcs.set(pvc.metadata.name, pvc)
      return Response.json(pvc, { status: 201 })
    }
    if (url.pathname === `${base}/persistentvolumeclaims/${name}` && req.method === 'DELETE') {
      return pvcs.delete(name) ? Response.json({}) : status(404, 'not found')
    }
    return status(404, `no route ${req.method} ${url.pathname}`)
  },
})
afterAll(() => api.stop(true))

const tokenFile = join(TMP, 'kube-token')
mkdirSync(TMP, { recursive: true })
writeFileSync(tokenFile, 'token-1')
const kube = makeKube(`http://127.0.0.1:${api.port}`, () => require('node:fs').readFileSync(tokenFile, 'utf8').trim(), undefined, NS, INSTANCE, {
  running: 30_000,
  gone: 500,
})
const labels = (slug: string) => ({ 'apps-builder/instance': INSTANCE, 'apps-builder/app': slug, 'apps-builder/owner': 'default' })
const specFor = async (slug: string, services: ('server' | 'redis' | 'postgres')[] = [], dataId = 'a1b2c3d4') =>
  podSpec(`ab-${INSTANCE}-${slug}`, labels(slug), services, 'tok', await kube.dataVolume(slug, dataId, services))

beforeEach(() => {
  pods.clear()
  pvcs.clear()
  quotaFull = false
  volumesFull = false
  stuck = false
  unschedulable = false
})

test('the pod is created as Global Constraints say', async () => {
  await kube.run(await specFor('shape', ['server', 'redis', 'postgres']))
  const pod = pods.get(`ab-${INSTANCE}-shape`)!
  const spec = pod.spec as Pod['spec'] & Record<string, any>
  expect(spec.runtimeClassName).toBe('gvisor')
  expect(spec.automountServiceAccountToken).toBe(false)
  expect(spec.enableServiceLinks).toBe(false)
  expect(spec.securityContext).toEqual({
    runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' },
  })
  expect(pod.metadata.labels).toMatchObject({ 'app.kubernetes.io/managed-by': 'apps-builder', 'apps-builder/owner': 'default', 'apps-builder/app': 'shape' })
  for (const c of spec.containers) {
    expect(c.resources.requests.cpu).toBeTruthy()
    expect(c.securityContext).toMatchObject({ allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true })
  }
  expect(JSON.stringify(spec.volumes)).not.toContain('hostPath')
  expect(spec.volumes.find((v: { name: string }) => v.name === 'app')).toEqual({ name: 'app', emptyDir: { sizeLimit: '256Mi' } })
  expect(spec.volumes.find((v: { name: string }) => v.name === 'data')).toEqual({ name: 'data', persistentVolumeClaim: { claimName: 'data-a1b2c3d4' } })
})

test('run returns the pod IP as the two addresses', async () => {
  const address = await kube.run(await specFor('addr'))
  expect(address.vite).toMatch(/^http:\/\/10\.0\.0\.\d+:5173$/)
  expect(address.control).toBe(address.vite.replace(':5173', ':5174'))
})

test('a DELETED event resolves exited()', async () => {
  await kube.run(await specFor('gone'))
  const exited = kube.exited(`ab-${INSTANCE}-gone`)
  let done = false
  void exited.then(() => (done = true))
  await Bun.sleep(100)
  expect(done).toBe(false)
  event('DELETED', pods.get(`ab-${INSTANCE}-gone`)!)
  await exited
})

test('phase Failed resolves exited()', async () => {
  await kube.run(await specFor('failed'))
  const exited = kube.exited(`ab-${INSTANCE}-failed`)
  const pod = pods.get(`ab-${INSTANCE}-failed`)!
  pod.status = { phase: 'Failed' }
  event('MODIFIED', pod)
  await exited
})

test('exceeded quota becomes the quota sentence, and no PVC is left', async () => {
  quotaFull = true
  const refused = await kube.run(await specFor('full', ['server', 'postgres'])).catch((e) => e)
  expect(refused).toBeInstanceOf(HttpError)
  // Not 409: createUnique reads a 409 from a new project's start as "that name is taken".
  expect((refused as HttpError).status).toBe(503)
  expect((refused as Error).message).toBe(QUOTA_FULL)
  expect(pvcs.size).toBe(0)
})

test('a database volume the quota refuses says so, and its pod is removed', async () => {
  volumesFull = true
  const refused = await kube.run(await specFor('novolume', ['server', 'postgres'])).catch((e) => e)
  expect(refused).toBeInstanceOf(HttpError)
  expect((refused as HttpError).status).toBe(503)
  // Stopping previews frees no volume: a data-<id> lives as long as its project.
  expect((refused as Error).message).toBe(VOLUMES_FULL)
  expect(pods.has(`ab-${INSTANCE}-novolume`)).toBe(false)
})

test("the preview container's death resolves exited(), though the pod's other containers run on", async () => {
  await kube.run(await specFor('vite-died', ['server']))
  const exited = kube.exited(`ab-${INSTANCE}-vite-died`)
  const pod = pods.get(`ab-${INSTANCE}-vite-died`)! as Stored & { status: Record<string, unknown> }
  pod.status = { ...pod.status, phase: 'Running', containerStatuses: [{ name: 'server', state: { running: {} } }, { name: 'preview', state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] }
  event('MODIFIED', pod)
  await exited
})

test('a pod marked for deletion resolves exited(), before it is gone', async () => {
  await kube.run(await specFor('terminating'))
  const exited = kube.exited(`ab-${INSTANCE}-terminating`)
  const pod = pods.get(`ab-${INSTANCE}-terminating`)! as Stored & { metadata: Record<string, unknown> }
  pod.metadata = { ...pod.metadata, deletionTimestamp: new Date().toISOString() }
  event('MODIFIED', pod)
  await exited
})

test('a pod on a dead node is removed at its deadline, forced, when it holds no database', async () => {
  await kube.run(await specFor('stuck'))
  stuck = true
  await kube.remove(`ab-${INSTANCE}-stuck`)
  expect(pods.has(`ab-${INSTANCE}-stuck`)).toBe(false)
})

test("a pod holding its database's volume is never forced: remove() fails at its deadline, naming the node", async () => {
  // Forced, its replacement could start on another node while this one still writes PGDATA.
  await kube.run(await specFor('stuck-data', ['server', 'postgres']))
  stuck = true
  await expect(kube.remove(`ab-${INSTANCE}-stuck-data`)).rejects.toThrow(/still terminating on node-1/)
  expect(pods.has(`ab-${INSTANCE}-stuck-data`)).toBe(true)
})

test("a refused database volume says so, though its pod can't be removed", async () => {
  volumesFull = true
  stuck = true
  const refused = await kube.run(await specFor('novolume-stuck', ['server', 'postgres'])).catch((e) => e)
  expect((refused as Error).message).toBe(VOLUMES_FULL)
})

test("a pod that doesn't run in time says why: the scheduler's words", async () => {
  unschedulable = true
  const quick = makeKube(`http://127.0.0.1:${api.port}`, () => 'token', undefined, NS, INSTANCE, { running: 300, gone: 500 })
  await expect(quick.run(await specFor('pending'))).rejects.toThrow(/not running within 0.3s: 0\/3 nodes are available: 3 Insufficient memory/)
})

test('run creates data-<dataId> once, longhorn-local, backup labels', async () => {
  await kube.run(await specFor('data', ['server', 'redis'], 'deadbeef'))
  await kube.remove(`ab-${INSTANCE}-data`)
  await kube.run(await specFor('data', ['server', 'redis'], 'deadbeef'))
  expect([...pvcs.keys()]).toEqual(['data-deadbeef'])
  const pvc = pvcs.get('data-deadbeef')!
  expect(pvc.spec).toMatchObject({ storageClassName: 'longhorn-local', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } })
  expect(pvc.metadata.labels).toMatchObject({
    'recurring-job.longhorn.io/source': 'enabled',
    'recurring-job-group.longhorn.io/backup': 'enabled',
    'apps-builder/app': 'data',
    'apps-builder/owner': 'default',
  })
  await kube.removeData('data', 'deadbeef')
  expect(pvcs.size).toBe(0)
})

test("removeAll deletes only this instance's pods", async () => {
  await kube.run(await specFor('one'))
  await kube.run(await specFor('two'))
  pods.set('someone-else', { ...pods.get(`ab-${INSTANCE}-one`)!, metadata: { name: 'someone-else', labels: { 'apps-builder/instance': 'other' } } })
  await kube.removeAll()
  expect([...pods.keys()]).toEqual(['someone-else'])
})

test('the token file is read on each call', async () => {
  writeFileSync(tokenFile, 'token-2')
  await kube.logs(`ab-${INSTANCE}-x`, 'server')
  expect(auths.at(-1)).toBe('Bearer token-2')
  writeFileSync(tokenFile, 'token-3')
  expect(await kube.logs(`ab-${INSTANCE}-x`, 'server')).toBe('last line of server')
  expect(auths.at(-1)).toBe('Bearer token-3')
})
