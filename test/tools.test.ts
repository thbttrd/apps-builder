/**
 * The model's file tools on disk: edit_file's patch and the diff each write keeps, the host's
 * files nothing the model writes may reach, and the labels its rows carry.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'bun:test'
import { stepCountIs, streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { applyEdit, tools } from '../server/tools'
import { type Edit, lineDiff } from '../shared/diff'
import { toolDetail } from '../shared/labels'
import { TMP, check, usage } from './fixtures'

test('edit_file: the patch tool', async () => {
  const e1 = applyEdit('a b a-b c', 'a-', '$&')
  check('text' in e1 && e1.text === 'a b $&b c', `edit: $& in new_string is text, not a pattern -> ${JSON.stringify(e1)}`)
  const e2 = applyEdit('one two', 'three', '3')
  check('error' in e2 && e2.error.startsWith('old_string is not in the file'), `edit: a miss is an error -> ${JSON.stringify(e2)}`)
  const e3 = applyEdit('x = 1\nx = 1', 'x = 1', 'x = 2')
  check('error' in e3 && e3.error.includes('2 times'), `edit: text found twice is refused, not guessed -> ${JSON.stringify(e3)}`)
  const e5 = applyEdit('abc', '', 'x')
  check('error' in e5, `edit: an empty old_string is refused, not looked for forever -> ${JSON.stringify(e5)}`)
  const e4 = applyEdit('aaa', 'aa', 'b')
  check('error' in e4 && e4.error.includes('2 times'), `edit: so is text found twice overlapping — 'aa' in 'aaa' -> ${JSON.stringify(e4)}`)
  // Through the SDK, on the real tools(): edits to one file in one message all land, in the
  // order they came — one across two lines with quotes in it, the shape GLM's provider cut
  // short when the strings sat in an array; a file that is not there, and one outside the
  // source, are refused.
  const editDir = join(TMP, 'edit-check')
  await Bun.write(join(editDir, 'src', 'Home.tsx'), 'const colour = "blue"\nconst size = 1\n')
  await Bun.write(join(editDir, '.apps-builder', 'project.json'), '{"usd":1}')
  const editOwn = new Set<string>()
  const editRun = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'a', toolName: 'edit_file', input: JSON.stringify({ path: 'src/Home.tsx', old_string: '"blue"', new_string: '"green"' }) },
            { type: 'tool-call', toolCallId: 'b', toolName: 'edit_file', input: JSON.stringify({ path: 'src/Home.tsx', old_string: 'size = 1', new_string: 'size = 2' }) },
            { type: 'tool-call', toolCallId: 'r', toolName: 'read_file', input: JSON.stringify({ path: 'src/Home.tsx' }) },
            { type: 'tool-call', toolCallId: 'm', toolName: 'edit_file', input: JSON.stringify({ path: 'src/Home.tsx', old_string: 'const colour = "green"\nconst size = 2', new_string: 'const colour = "red"\nconst size = 3' }) },
            { type: 'tool-call', toolCallId: 'c', toolName: 'edit_file', input: JSON.stringify({ path: 'src/Gone.tsx', old_string: 'x', new_string: 'y' }) },
            { type: 'tool-call', toolCallId: 'd', toolName: 'edit_file', input: JSON.stringify({ path: '.apps-builder/project.json', old_string: '1', new_string: '0' }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        },
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]),
        },
      ],
    }),
    prompt: 'make it green and bigger',
    tools: tools('edit-check', editDir, { own: editOwn }),
    stopWhen: stepCountIs(3),
  })
  await editRun.consumeStream()
  const editParts = (await editRun.steps)[0]?.content ?? []
  const resultOf = (id: string) => {
    const p = editParts.find((x) => (x.type === 'tool-result' || x.type === 'tool-error') && x.toolCallId === id)
    return p?.type === 'tool-result' ? String(p.output) : p?.type === 'tool-error' ? `error: ${String(p.error)}` : 'none'
  }
  check(
    (await Bun.file(join(editDir, 'src', 'Home.tsx')).text()) === 'const colour = "red"\nconst size = 3\n' &&
      resultOf('a') === 'edited src/Home.tsx' && resultOf('m') === 'edited src/Home.tsx' && [...editOwn].join() === 'src/Home.tsx',
    `edit: three edits to one file in one message all land, the two-line one too, and the file is the turn's own -> ${JSON.stringify(await Bun.file(join(editDir, 'src', 'Home.tsx')).text())}`,
  )
  check(resultOf('r') === 'const colour = "green"\nconst size = 2\n', `edit: a read after the edits in their message sees them -> ${JSON.stringify(resultOf('r'))}`)
  check(resultOf('c').startsWith('Not written: there is no src/Gone.tsx'), `edit: a file that is not there -> ${resultOf('c')}`)
  check(
    resultOf('d').includes('not a source file') && (await Bun.file(join(editDir, '.apps-builder', 'project.json')).text()) === '{"usd":1}',
    `edit: .apps-builder/project.json is not the model's to edit -> ${resultOf('d')}`,
  )
  // What each landed edit changed, for its row, and the file as the turn found it, for the code
  // pane: the first edit's before, not a later one's. A refused edit keeps nothing.
  const keptA = (await Bun.file(join(editDir, '.apps-builder', 'diffs', 'a.json')).json().catch(() => null)) as Edit | null
  const shape = (e: Edit | null) => e && `${e.path} +${e.added} -${e.removed} ${e.lines.map((l) => (l ? `${l.t}${l.n}` : '…')).join(' ')}`
  check(
    shape(keptA) === 'src/Home.tsx +1 -1 -1 +1  2' &&
      JSON.stringify(await Bun.file(join(editDir, '.apps-builder', 'turn.json')).json()) ===
        JSON.stringify({ 'src/Home.tsx': 'const colour = "blue"\nconst size = 1\n' }) &&
      !(await Bun.file(join(editDir, '.apps-builder', 'diffs', 'c.json')).exists()),
    `edit: each landed edit keeps its diff, the turn keeps the file as it found it, a refused edit nothing -> ${shape(keptA)}`,
  )
  // A directory with a project.json is listed as a project, and the smoke opens the first one.
  await rm(editDir, { recursive: true, force: true })
  // The diff itself: a line changed and one appended, numbered in their own files; a file's last
  // newline is not a line of its own; past the cap, the middle is all removed then all added.
  const signs = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.t}${l.n}`).join(' ')
  // 2,002 lines a side between the first and the last, which differ: over the cap, though an LCS
  // would keep the 2,000 the two share.
  const shared = Array.from({ length: 2000 }, (_, i) => `${i}`).join('\n')
  const run = (t: string, n: number) => Array.from({ length: n }, (_, i) => `${t}${i + 1}`)
  check(
    signs('a\nb\nc\n', 'a\nB\nc\nd\n') === ' 1 -2 +2  3 +4' && signs('', 'x\n') === '+1' && signs('x\n', 'x') === ' 1' &&
      signs(`A\n${shared}\nZ`, `B\n${shared}\nY`) === [...run('-', 2002), ...run('+', 2002)].join(' '),
    `diff: numbered in their own files, no phantom last line, the cap falls back -> ${signs('a\nb\nc\n', 'a\nB\nc\nd\n')}`,
  )
})

test("the host's files: nothing the model writes is run by the preview's Node", async () => {
  // vite.config.* by any path to it, and an @plugin or @config by a write or by an edit, are
  // refused and leave the disk as it was; the app's own files still write.
  const hostDir = join(TMP, 'host-check')
  await Bun.write(join(hostDir, 'vite.config.ts'), 'export default {}\n')
  await Bun.write(join(hostDir, 'src', 'app.css'), "@import 'tailwindcss';\n")
  const hostTools = tools('host-check', hostDir)
  const hostRun = (name: 'write_file' | 'edit_file' | 'delete_file', input: object) =>
    Promise.resolve(hostTools[name].execute!(input as never, { toolCallId: 'h', messages: [] } as never)).then(String)
  const hostOut = [
    await hostRun('write_file', { path: 'vite.config.ts', content: 'export default { base: "/" }\n' }),
    await hostRun('edit_file', { path: 'src/../vite.config.ts', old_string: '{}', new_string: '{ base: "/" }' }),
    await hostRun('delete_file', { path: 'vite.config.ts' }),
    await hostRun('write_file', { path: 'vite.config.mjs', content: 'export default {}\n' }),
    await hostRun('write_file', { path: 'src/extra.css', content: '@plugin "./extra.js";\n' }),
    await hostRun('edit_file', { path: 'src/app.css', old_string: "@import 'tailwindcss';", new_string: "@import 'tailwindcss';\n@CONFIG './t.js';" }),
  ]
  const hostDisk = [
    await Bun.file(join(hostDir, 'vite.config.ts')).text(),
    await Bun.file(join(hostDir, 'src', 'app.css')).text(),
    String(await Bun.file(join(hostDir, 'vite.config.mjs')).exists()),
    String(await Bun.file(join(hostDir, 'src', 'extra.css')).exists()),
  ]
  check(
    hostOut.every((o) => o.startsWith('Not written')) && hostDisk.join('|') === "export default {}\n|@import 'tailwindcss';\n|false|false",
    `host: vite.config.* and an @plugin / @config are refused, and the disk is as it was -> ${JSON.stringify(hostOut.filter((o) => !o.startsWith('Not written')))} ${JSON.stringify(hostDisk)}`,
  )
  const hostFine = await hostRun('write_file', { path: 'src/Home.tsx', content: 'export default () => null\n' })
  check(hostFine.startsWith('wrote src/Home.tsx'), `host: the app's own files still write -> ${hostFine}`)
  // The first build keeps each write's diff for its row, and nothing for the code pane to colour:
  // every file it writes is new to the person, and the pane was the whole app in green.
  await rm(join(hostDir, '.apps-builder', 'turn.json'), { force: true }) // the built turn's, above
  const firstTools = tools('host-check', hostDir, { built: false })
  await firstTools.write_file.execute!({ path: 'src/Home.tsx', content: 'export default () => <h1>Invoices</h1>\n' }, { toolCallId: 'f1', messages: [] } as never)
  check(
    (await Bun.file(join(hostDir, '.apps-builder', 'diffs', 'f1.json')).exists()) && !(await Bun.file(join(hostDir, '.apps-builder', 'turn.json')).exists()),
    'first build: its rows keep their diffs, and the code pane has nothing to colour',
  )
  await rm(hostDir, { recursive: true, force: true })
})

test('labels', async () => {
  check(
    toolDetail('update_plan', { steps: [{ status: 'done' }, { status: 'doing' }] }) === '1/2 done' &&
      toolDetail('check_app', { path: '/', steps: [] }) === '/',
    'labels: an update_plan row says how far the plan has got; a check_app row with no steps is still its route',
  )
})


test("check_app says why the preview could not be started: the person may have to act (the quota's 503)", async () => {
  const dir = join(TMP, 'unstartable')
  await Bun.write(join(dir, 'package.json'), '{}')
  await Bun.write(join(dir, 'bun.lock'), 'not the template lock')
  const report = await tools('unstartable', dir).check_app.execute!({ path: '/', viewport: 'desktop', steps: [] }, { toolCallId: 'c', messages: [] } as never)
  check(String(report).includes("bun.lock is not the template's"), `check_app's report names the refusal -> ${report}`)
})
