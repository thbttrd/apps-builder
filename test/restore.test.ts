/**
 * Restore is file surgery on a project's whole tree, so it is checked directly rather
 * than through the UI: a scratch project, real commits, real git, no server and no model.
 *
 * The cases here are the ones that are wrong in the obvious implementation — a file added
 * after the target that survives the restore, a spend tally that quietly rewinds with the
 * code, and a code-only restore that leaves the model believing it wrote something that
 * is no longer on disk.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, test } from 'bun:test'
import { checkpoint, listSnapshots, restoreSnapshot } from '../server/git'
import { HttpError, shotPath } from '../server/project'
import { TMP, check } from './fixtures'

const SLUG = 'restore-demo'
const DIR = join(TMP, SLUG)

const write = (p: string, s: string) => Bun.write(join(DIR, p), s)
const read = (p: string) => Bun.file(join(DIR, p)).text()
const exists = (p: string) => Bun.file(join(DIR, p)).exists()
const chat = async () => JSON.parse(await read('.apps-builder/chat.json')) as { role: string; content: string }[]
const git = (...args: string[]) => Bun.spawn(['git', ...args], { cwd: DIR, stdout: 'ignore', stderr: 'ignore' }).exited
// History starts at the first build, so the scaffold is in the log but not in the list.
const kinds = async () => (await listSnapshots(SLUG)).snapshots.map((s) => s.kind).join(',')

let scaffold: string | null
let turn: string | null

beforeAll(async () => {
  // setup.ts points project.ts at the scratch directory before anything imports it. Asked
  // anyway, and loudly: were it ever the real one, this suite runs `git read-tree -u --reset`
  // against a real project, and tsc would not say a word.
  if (!shotPath(SLUG).startsWith(TMP)) throw new Error('project.ts is not on the scratch directory — refusing to run')
  await mkdir(DIR, { recursive: true })
  await write('package.json', '{"name":"demo"}')
  await write('src/Home.tsx', 'v1')
  await write('.apps-builder/project.json', JSON.stringify({ usd: 1.23, turns: 7 }))
  await write('.apps-builder/chat.json', JSON.stringify([{ role: 'user', content: 'hello' }]))
  await git('init', '-q')
  scaffold = await checkpoint(DIR, 'scaffold')

  await write('src/Home.tsx', 'v2')
  await write('src/New.tsx', 'added by the turn')
  await write('.apps-builder/project.json', JSON.stringify({ usd: 2.5, turns: 8 }))
  await write(
    '.apps-builder/chat.json',
    JSON.stringify([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'make it v2' },
      { role: 'assistant', content: 'done' },
    ]),
  )
  turn = await checkpoint(DIR, 'turn 1: make it v2')
})

test('the timeline', async () => {
  check((await listSnapshots(SLUG)).head === turn, 'head is the newest commit')
  check((await kinds()) === 'turn', 'one snapshot, the turn: the scaffold before the first build is not shown')
})

test('code + chat → scaffold', async () => {
  await restoreSnapshot(SLUG, scaffold!, 'code+chat')
  check((await read('src/Home.tsx')) === 'v1', 'the file went back')
  check(!(await exists('src/New.tsx')), 'a file added after the target is gone (not just skipped)')
  check((await chat()).length === 1, 'the conversation went back with it')
  check(JSON.parse(await read('.apps-builder/project.json')).usd === 2.5, 'the spend tally did NOT rewind')
  check((await kinds()) === 'restore,turn', 'restore appended, nothing was destroyed')
})

test('code + chat → back to the turn', async () => {
  await restoreSnapshot(SLUG, turn!, 'code+chat')
  check((await read('src/Home.tsx')) === 'v2', 'N-1 → N works')
  check(await exists('src/New.tsx'), 'the added file came back')
  check((await chat()).length === 3, 'the conversation came back too')
})

test('code only → scaffold', async () => {
  await restoreSnapshot(SLUG, scaffold!, 'code')
  check((await read('src/Home.tsx')) === 'v1', 'the file went back')
  check(!(await exists('src/New.tsx')), 'the added file is gone')
  const after = await chat()
  check(after.length === 4, 'the conversation was kept, plus one note')
  check(after[3]?.role === 'user', 'the note is a user turn, so the client can render it')
  check(String(after[3]?.content).includes(scaffold!), 'the note names the snapshot restored to')
  check(JSON.parse(await read('.apps-builder/project.json')).usd === 2.5, 'the spend tally still did not rewind')
})

test('guards', async () => {
  const before = (await listSnapshots(SLUG)).snapshots.length
  await restoreSnapshot(SLUG, (await listSnapshots(SLUG)).head, 'code+chat')
  check((await listSnapshots(SLUG)).snapshots.length === before, 'restoring to HEAD makes no commit')

  const status = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      return 0
    } catch (e) {
      return e instanceof HttpError ? e.status : -1
    }
  }
  check((await status(() => restoreSnapshot(SLUG, '../../etc', 'code+chat'))) === 400, 'a sha that is not a sha is a 400')
  check((await status(() => restoreSnapshot(SLUG, 'deadbee', 'code+chat'))) === 404, 'a sha from nowhere is a 404')
})
