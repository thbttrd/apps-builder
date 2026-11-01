/**
 * When the listing calls a project built: once the template's "/" page has left "/" — Home.tsx
 * rewritten or deleted, or main.tsx no longer naming it — in a commit after the scaffold, which is
 * where History starts too; and, so the preview slides in while the first build is still running,
 * once that is so on disk before the commit and the running preview serves the page (check-preview
 * proves that half on a real vite). Anything else — a plan, a lib file, the theme, the shell's new
 * name — leaves the template at "/", and the chat alone.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'bun:test'
import { checkpoint, isBuilt, listSnapshots, pageReplaced } from '../server/git'
import { projectOf } from '../server/previews'
import { TMP, check } from './fixtures'

/** The template's router, as main.tsx names its page; and one routing "/" to a page of its own. */
const ROUTER = "import Home from './Home'\n\nexport const routes = [{ path: '/', element: Home }]\n"
const MOVED = "import Market from './Market'\n\nexport const routes = [{ path: '/', element: Market }]\n"

/** A project as createProject leaves it, in miniature: the template's page, routed at "/". */
async function scaffold(slug: string) {
  const dir = join(TMP, slug)
  const write = (p: string, s: string) => Bun.write(join(dir, p), s)
  await mkdir(dir, { recursive: true })
  await write('package.json', '{}')
  await write('src/Home.tsx', 'template')
  await write('src/main.tsx', ROUTER)
  await write('src/AppShell.tsx', "const APP_NAME = 'New app'")
  await write('src/app.css', '@theme {}')
  await write('.apps-builder/project.json', '{}')
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
  await checkpoint(dir, 'scaffold')
  return {
    dir,
    write,
    built: async () => (await projectOf(slug)).built,
    history: async () => (await listSnapshots(slug)).snapshots.map((s) => s.subject).join(' | '),
  }
}

test("built: mid-turn, once the template's page is replaced on disk, and only with a preview to show it", async () => {
  const { dir, write, built } = await scaffold('built-demo')
  check(!(await built()), 'the scaffold alone is not built')

  await write('.apps-builder/plan.json', '{"steps":[]}')
  await write('src/lib/tip.ts', 'export const tip = 0.15')
  await write('src/AppShell.tsx', "const APP_NAME = 'Tip Splitter'")
  check(!(await pageReplaced(dir)) && !(await built()), 'a plan, a lib file and a new name, uncommitted: still the template, not built')

  await rm(join(dir, 'src/Home.tsx'))
  check(await pageReplaced(dir), 'Home.tsx deleted: replaced on disk')
  await write('src/Home.tsx', 'the app')
  check((await pageReplaced(dir)) && !(await isBuilt(dir)), 'Home.tsx rewritten: replaced on disk, not yet committed')
  check(!(await built()), 'with no preview running to show it, the listing does not call it built before the commit')

  await checkpoint(dir, 'turn 1: a tip splitter')
  check(!(await pageReplaced(dir)) && (await built()), 'committed: built by the commit, nothing left uncommitted')
})

test("built: a turn that leaves the template's page at \"/\" does not build it, whatever else it wrote", async () => {
  const { dir, write, built, history } = await scaffold('built-shell')
  await write('src/app.css', '@theme { --color-primary: green }')
  await write('src/AppShell.tsx', "const APP_NAME = 'Tip Splitter'")
  await checkpoint(dir, 'turn 1: the theme and the shell')
  check(
    !(await built()) && (await history()) === '',
    `the theme and a new name, committed: the template is still at "/", so not built, and History is empty -> ${await history()}`,
  )
  await write('src/Home.tsx', 'the app')
  await checkpoint(dir, 'turn 2: the page')
  check((await built()) && (await history()) === 'turn 2: the page', `the turn that replaces the page builds it, and History starts there -> ${await history()}`)
})

test('built: Home.tsx deleted and "/" routed to a page named for its job, as six projects did', async () => {
  const { dir, write, built, history } = await scaffold('built-moved')
  await rm(join(dir, 'src/Home.tsx'))
  await write('src/main.tsx', MOVED)
  await write('src/Market.tsx', 'the market')
  check(await pageReplaced(dir), 'on disk: replaced')
  await checkpoint(dir, 'turn 1: the market')
  check((await built()) && (await history()) === 'turn 1: the market', `committed: built, History from that turn -> ${await history()}`)
})

test('built: Home.tsx left as it was and "/" routed elsewhere, never seen, is no project stuck unbuilt', async () => {
  const { dir, write, built, history } = await scaffold('built-left')
  await write('src/main.tsx', MOVED)
  await write('src/Market.tsx', 'the market')
  check(await pageReplaced(dir), 'on disk: main.tsx no longer names the template page, so it is replaced')
  await checkpoint(dir, 'turn 1: the market')
  check((await built()) && (await history()) === 'turn 1: the market', `committed: built by the route alone, History from that turn -> ${await history()}`)
})
