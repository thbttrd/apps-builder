/**
 * The preview's control port takes the project's files: apps-builder pushes the
 * source into the pod's empty /app, then every change. The pod runs the model's code beside it, so a
 * push names paths under /app only — no escape, no node_modules or .git, through no symlink — and
 * only with the token apps-builder gave this pod.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { startControl } from '../server/preview-control.mjs'
import { TMP } from './fixtures'

const root = join(TMP, 'push-root')
const elsewhere = join(TMP, 'push-elsewhere')
const TOKEN = 'push-test-token'
let firstPushes = 0
const server = startControl({ root, token: TOKEN, port: 0, onFirstPush: () => firstPushes++ })
await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
afterAll(() => server.close())

const b64 = (s: string) => Buffer.from(s).toString('base64')
const push = (files: Record<string, string | null>, token = TOKEN) =>
  fetch(`${base}/_ab/push`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
  })

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

test('a push writes, overwrites and deletes under root', async () => {
  expect((await push({ 'index.html': b64('<p>1</p>'), 'src/deep/a.ts': b64('a'), 'gone.txt': b64('x') })).status).toBe(204)
  expect((await push({ 'index.html': b64('<p>2</p>'), 'gone.txt': null, 'src/deep/a.ts': null })).status).toBe(204)
  expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<p>2</p>')
  expect(existsSync(join(root, 'gone.txt'))).toBe(false)
  // the deletion took its now-empty parents with it, never root itself
  expect(existsSync(join(root, 'src'))).toBe(false)
  expect(existsSync(root)).toBe(true)
})

test('a wrong token is 401 and writes nothing', async () => {
  expect((await push({ ok: b64('hi') }, 'not-the-token')).status).toBe(401)
  const bare = await fetch(`${base}/_ab/push`, { method: 'POST', body: JSON.stringify({ files: { ok: b64('hi') } }) })
  expect(bare.status).toBe(401)
  expect(existsSync(join(root, 'ok'))).toBe(false)
})

test('one bad path refuses the whole push', async () => {
  for (const bad of ['../x', '/etc/x', 'a/../../x', 'node_modules/x', '.git/hooks/pre-commit', '.apps-builder/chat.json', 'dist/x', 'a\0b', '']) {
    expect((await push({ ok: b64('hi'), [bad]: b64('hi') })).status).toBe(400)
    expect(existsSync(join(root, 'ok'))).toBe(false)
  }
})

test('a symlink out of root is refused', async () => {
  mkdirSync(elsewhere, { recursive: true })
  symlinkSync(elsewhere, join(root, 'link'))
  expect((await push({ 'link/x': b64('hi') })).status).toBe(400)
  expect(existsSync(join(elsewhere, 'x'))).toBe(false)
})

test('a push over 32 MiB is 413', async () => {
  const big = 'a'.repeat(33 * 1024 * 1024)
  const r = await fetch(`${base}/_ab/push`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: big })
  expect(r.status).toBe(413)
})

test('onFirstPush fires once, after the first 204', async () => {
  const before = firstPushes
  expect((await push({ a: b64('1') })).status).toBe(204)
  expect((await push({ b: b64('2') })).status).toBe(204)
  // earlier tests already pushed: the counter moved once in this whole file, never again
  expect(firstPushes).toBe(1)
  expect(before).toBe(1)
})

test('a write that fails answers 500, and the control port lives on', async () => {
  expect((await push({ a: b64('a file') })).status).toBe(204)
  // `a` is a file: a/b can't be made. An async handler's throw would end the pod's node, vite with it.
  expect((await push({ 'a/b': b64('x') })).status).toBe(500)
  expect((await push({ c: b64('still here') })).status).toBe(204)
})
