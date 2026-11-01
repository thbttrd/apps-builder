/**
 * A preview's life in previews.ts, its pod faked: backend.ts is mocked (run hands back the fake pod's
 * address, remove records the name), and the fake pod is one Bun.serve answering the control port and
 * vite as the real ones do. Under test: Stop, and the reaper that stops a preview nobody uses.
 * mock.module holds for the whole `bun test` process: no other test file starts or stops a preview.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, mock, test } from 'bun:test'
import { TMP } from './fixtures'

const removed: string[] = []
/** removeData fails, as a PVC delete the API refuses does. */
let dataRefused = false
const pod = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/_ab/push') return new Response(null, { status: 204 })
    // The line's long poll, held until apps-builder lets go of it.
    if (pathname === '/_ab/line') return new Promise<Response>((r) => req.signal.addEventListener('abort', () => r(new Response(null, { status: 204 }))))
    return new Response('ok')
  },
})
const address = `http://127.0.0.1:${pod.port}`
mock.module('../server/backend', () => ({
  INSTANCE: 'unit',
  backend: {
    run: async () => ({ vite: address, control: address }),
    remove: async (name: string) => void removed.push(name),
    removeAll: async () => {},
    exited: () => new Promise<void>(() => {}),
    logs: async () => '',
    dataVolume: async () => undefined,
    removeData: async () => {
      if (dataRefused) throw new Error('delete data-x: 500 the API refused')
    },
    renameData: async () => {},
  },
}))
const { addressOf, deleteProject, projectOf, reapIdle, startPreview } = await import('../server/previews')
const { websocket } = await import('../server/dispatch')
const { app } = await import('../server/routes')
const { claimed } = await import('../server/agent')

/** A project as far as a start needs one: a package.json, and the template's lockfile. */
async function started(slug: string): Promise<string> {
  const dir = join(TMP, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{}')
  copyFileSync(join(import.meta.dir, '..', 'template', 'bun.lock'), join(dir, 'bun.lock'))
  await startPreview(slug, false)
  return slug
}
const runs = async (slug: string) => (await projectOf(slug)).running
const never = () => false

test('Stop stops the preview, and answers the project as the listing now shows it', async () => {
  const slug = await started('stop-me')
  const r = await app.request(`/api/projects/${slug}/stop`, { method: 'POST' })
  expect(r.status).toBe(200)
  expect(((await r.json()) as { running: boolean }).running).toBe(false)
  expect(removed).toContain(`ab-unit-${slug}`)
})

test('Stop is refused while a turn runs on the project: its check_app would start it again', async () => {
  const slug = await started('mid-turn')
  const r = await claimed(slug, 'busy', async () => app.request(`/api/projects/${slug}/stop`, { method: 'POST' }))
  expect(r.status).toBe(409)
  expect(await runs(slug)).toBe(true)
})

test('the reaper stops a preview nobody uses, and only that one', async () => {
  const slug = await started('idle-app')
  await reapIdle(() => true, 0)
  expect(await runs(slug)).toBe(true) // a turn runs on it
  await reapIdle(never, 60_000)
  expect(await runs(slug)).toBe(true) // started a moment ago
  await reapIdle(never, 0)
  expect(await runs(slug)).toBe(false)
})

test('a request to the preview, or check_app, counts as use', async () => {
  const slug = await started('used-app')
  await Bun.sleep(40)
  addressOf(slug) // what the dispatcher and check_app call on every request
  await reapIdle(never, 30)
  expect(await runs(slug)).toBe(true)
  await Bun.sleep(40)
  await reapIdle(never, 30)
  expect(await runs(slug)).toBe(false)
})

test('an open HMR socket keeps it: a tab or a gallery card shows it', async () => {
  const slug = await started('watched-app')
  const ws = { data: { slug, target: `ws://127.0.0.1:${pod.port}/`, protocol: '', queue: [] }, send() {}, close() {} }
  websocket.open?.(ws as never)
  await reapIdle(never, 0)
  expect(await runs(slug)).toBe(true)
  websocket.close?.(ws as never, 1000, '')
  await reapIdle(never, 30)
  expect(await runs(slug)).toBe(true) // the tab closed just now: maybe a reload
  await Bun.sleep(40)
  await reapIdle(never, 30)
  expect(await runs(slug)).toBe(false)
})

test("a delete whose database volume can't be removed keeps the project: nothing points at a lost volume", async () => {
  const slug = await started('keeps-its-data')
  dataRefused = true
  await expect(deleteProject(slug)).rejects.toThrow('the API refused')
  dataRefused = false
  expect(existsSync(join(TMP, slug, 'package.json'))).toBe(true)
  await deleteProject(slug) // and the retry goes through
  expect(existsSync(join(TMP, slug))).toBe(false)
})
