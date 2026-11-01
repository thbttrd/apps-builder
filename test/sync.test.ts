/**
 * apps-builder pushes a project into its preview's pod: the whole source at start,
 * then whatever changed, and flush() waits until the pod has everything the disk had when it was called.
 * The pod here is a fake control port keeping the pushed files in a map; it can be told to answer slowly.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { type Sync, startSync } from '../server/sync'
import { TMP } from './fixtures'

const TOKEN = 'sync-test-token'
const dir = join(TMP, 'sync-project')
const pod = new Map<string, Buffer>()
let delayMs = 0
let pushes = 0
/** Pushes the fake refuses with a 500 before it takes one. */
let failNext = 0
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 })
    // The real control port's limit (preview-control.mjs).
    const body = await req.text()
    if (body.length > 32 * 1024 * 1024) return new Response('too large', { status: 413 })
    const { files } = JSON.parse(body) as { files: Record<string, string | null> }
    await Bun.sleep(delayMs)
    if (failNext > 0) {
      failNext--
      return new Response('disk full', { status: 500 })
    }
    for (const [path, data] of Object.entries(files)) {
      if (data === null) pod.delete(path)
      else pod.set(path, Buffer.from(data, 'base64'))
    }
    pushes++
    return new Response(null, { status: 204 })
  },
})
const control = `http://127.0.0.1:${fake.port}`
let sync: Sync | undefined

const write = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), data)
}
/** The disk as the pod should hold it: every file, minus the excluded top-level names. */
const disk = (): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const rel = relative(dir, p)
      if (['node_modules', '.git', '.apps-builder', 'dist'].includes(rel.split('/')[0]!)) continue
      if (e.isDirectory()) walk(p)
      else out[rel] = readFileSync(p).toString('base64')
    }
  }
  walk(dir)
  return out
}
const inPod = () => Object.fromEntries([...pod].map(([k, v]) => [k, v.toString('base64')]))

async function scaffold() {
  rmSync(dir, { recursive: true, force: true })
  pod.clear()
  delayMs = 0
  failNext = 0
  write('index.html', '<div id="root"></div>')
  write('src/main.tsx', 'import "./app.css"')
  write('src/app.css', '@theme {}')
  write('node_modules/vite/index.js', 'not pushed')
  write('.git/HEAD', 'ref: refs/heads/main')
  write('.apps-builder/chat.json', '[]')
  write('dist/index.html', 'built')
}

afterEach(() => sync?.stop())

test('the initial push is the tree minus node_modules, .git, .apps-builder, dist', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  expect(Object.keys(inPod()).sort()).toEqual(['index.html', 'src/app.css', 'src/main.tsx'])
})

test('a write is pushed, and flush() waits for it', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  delayMs = 200
  write('src/Home.tsx', 'export default 1')
  await sync.flush()
  expect(pod.get('src/Home.tsx')?.toString()).toBe('export default 1')
})

test('a write is pushed without a flush: the watcher', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  write('src/Watched.tsx', 'export default 2')
  for (let i = 0; i < 40 && !pod.has('src/Watched.tsx'); i++) await Bun.sleep(25)
  expect(pod.get('src/Watched.tsx')?.toString()).toBe('export default 2')
})

test('a file written during the initial push is there after flush()', async () => {
  await scaffold()
  delayMs = 300
  const starting = startSync(dir, control, TOKEN)
  await Bun.sleep(50)
  write('src/late.ts', 'late')
  sync = await starting
  await sync.flush()
  expect(inPod()).toEqual(disk())
})

test('50 writes in a burst: after flush() the pod equals the disk', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  delayMs = 20
  for (let i = 0; i < 50; i++) write(`src/burst/f${i % 17}.ts`, `export const n = ${i}`)
  await sync.flush()
  expect(inPod()).toEqual(disk())
  expect(pod.get('src/burst/f15.ts')?.toString()).toBe('export const n = 49')
})

test('a delete and a directory rename leave no old path in the pod', async () => {
  await scaffold()
  write('src/old/a.ts', 'a')
  write('src/old/b.ts', 'b')
  sync = await startSync(dir, control, TOKEN)
  rmSync(join(dir, 'src/app.css'))
  renameSync(join(dir, 'src/old'), join(dir, 'src/new'))
  await sync.flush()
  expect(inPod()).toEqual(disk())
  expect([...pod.keys()].some((k) => k.startsWith('src/old/') || k === 'src/app.css')).toBe(false)
})

test('a binary file arrives byte for byte', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(70_000)))
  write('public/noise.bin', bytes)
  await sync.flush()
  expect(pod.get('public/noise.bin')?.equals(bytes)).toBe(true)
})

test('stop() ends the watcher; later writes are not pushed', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  sync.stop()
  const before = pushes
  write('src/after.ts', 'after')
  await Bun.sleep(300)
  expect(pod.has('src/after.ts')).toBe(false)
  expect(pushes).toBe(before)
})

test('a wrong token rejects startSync with the pod\'s answer', async () => {
  await scaffold()
  await expect(startSync(dir, control, 'not-the-token')).rejects.toThrow('401')
})

test('a file too large for any push is left out, and the rest still syncs', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  write('public/huge.bin', Buffer.alloc(25 * 1024 * 1024, 1))
  write('src/after-huge.ts', 'still synced')
  await sync.flush()
  expect(pod.has('public/huge.bin')).toBe(false)
  expect(pod.get('src/after-huge.ts')?.toString()).toBe('still synced')
  write('src/later.ts', 'later too')
  await sync.flush()
  expect(pod.get('src/later.ts')?.toString()).toBe('later too')
}, 20_000)

test('a failed push is sent again without a new edit', async () => {
  await scaffold()
  sync = await startSync(dir, control, TOKEN)
  failNext = 1
  write('src/retried.ts', 'once more')
  for (let i = 0; i < 120 && !pod.has('src/retried.ts'); i++) await Bun.sleep(25)
  expect(pod.get('src/retried.ts')?.toString()).toBe('once more')
})

test('a push the pod never answers fails at the deadline, not never', async () => {
  await scaffold()
  delayMs = 60_000
  const started = Date.now()
  await expect(startSync(dir, control, TOKEN, 300)).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(5000)
  delayMs = 0
}, 10_000)
