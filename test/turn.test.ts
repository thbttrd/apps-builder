/**
 * How a turn ends when the model does not end it: cut off at max_tokens, out of steps, over its
 * budget, failed by the provider; chat.json kept after every step; and the claim that keeps a
 * project to one writer.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'bun:test'
import { type ModelMessage, stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { artefacts, chat, claimed, cutOffNote, keepSteps, outOfStepsNote, overBudgetNote, running, unrun } from '../server/agent'
import { COMMIT, checkpoint, noteOutsideEdits } from '../server/git'
import { costOf } from '../server/model'
import { readMeta } from '../server/project'
import { tools } from '../server/tools'
import { toTurns } from '../src/turns'
import { TMP, check, noteOf, relayed, usage } from './fixtures'

/** A step that calls a tool and costs $0.30, as OpenRouter reports a cost. */
let paidN = 0
const paidStep = () =>
  convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: `c${++paidN}`, toolName: 'noop', input: '{}' },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
      providerMetadata: { openrouter: { usage: { cost: 0.3 } } },
    },
  ] satisfies LanguageModelV3StreamPart[])
const noop = { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) }

test('a reply cut off at max_tokens: the turn ends, and says why', async () => {
  // Running-fox's shape (2026-09-29): one step that only reasoned, stopped by the limit before
  // any tool call. The SDK's own steps, so the check holds its finishReason, not a guess at it.
  const cutSdk = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r' },
            { type: 'reasoning-delta', id: 'r', delta: 'Planning the whole engine in my head…' },
            { type: 'reasoning-end', id: 'r' },
            { type: 'finish', finishReason: { unified: 'length', raw: 'max_tokens' }, usage },
          ]),
        },
      ],
    }),
    prompt: 'so ?',
    tools: { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) },
    stopWhen: stepCountIs(5),
  })
  await relayed(cutSdk.fullStream)
  const cutSteps = await cutSdk.steps
  const cutNote = cutOffNote(cutSteps, 128_000)
  check(
    cutSteps.length === 1 && cutNote?.startsWith('⚠') === true,
    `cut: a reply stopped by the limit ends the turn with a ⚠ note -> ${cutSteps.map((x) => x.finishReason)} ${cutNote?.slice(0, 50)}`,
  )
  // What chat() writes: the turn, then the note as a user message, which reloads as a note.
  const cutReloaded = toTurns(
    JSON.parse(JSON.stringify([{ role: 'user', content: 'so ?' }, ...cutSteps.flatMap((x) => x.response.messages), { role: 'user', content: cutNote }])),
  )
  check(
    noteOf(cutReloaded.at(-1)) && cutReloaded.at(-2)?.role === 'assistant',
    `cut: reloaded, the note is a note, under the turn it ended -> ${cutReloaded.map((t) => t.role + (noteOf(t) ? ' (note)' : '')).join(', ')}`,
  )

  // A reply cut off after a whole tool call: the provider hands the call over, the SDK does not
  // run it on 'length', and chat.json would end on a call with no result, which every later
  // turn refused before sending anything. chat() stores a result saying it did not run.
  const cutDir = join(TMP, 'cut-check')
  const cutCallSdk = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'w', toolName: 'write_file', input: JSON.stringify({ path: 'src/Cut.tsx', content: 'x' }) },
            // One the SDK finds invalid, which it answers itself — in a tool message after the reply.
            { type: 'tool-call', toolCallId: 'x', toolName: 'no_such_tool', input: '{}' },
            { type: 'finish', finishReason: { unified: 'length', raw: 'max_tokens' }, usage },
          ]),
        },
      ],
    }),
    prompt: 'build it',
    tools: tools('cut-check', cutDir),
    stopWhen: stepCountIs(5),
  })
  await cutCallSdk.consumeStream()
  const cutCallMessages = (await cutCallSdk.steps).flatMap((x) => x.response.messages)
  const cutRepair = unrun(cutCallMessages)
  const repairedIds = cutRepair.flatMap((m) => (m.role === 'tool' ? m.content.map((p) => ('toolCallId' in p ? p.toolCallId : '')) : []))
  check(
    !(await Bun.file(join(cutDir, 'src', 'Cut.tsx')).exists()) && repairedIds.join() === 'w',
    `cut: a call in the cut reply is not run, and gets a result saying so — not the invalid one, which has its own -> ${repairedIds.join()}`,
  )
  const withAsk = unrun([
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'q', toolName: 'ask_user', input: {} },
        { type: 'tool-call', toolCallId: 'w2', toolName: 'write_file', input: {} },
      ],
    },
  ])
  check(
    JSON.stringify(withAsk).includes('"w2"') && !JSON.stringify(withAsk).includes('"q"'),
    'cut: a question in the cut reply stays open, for the next message to answer',
  )
  const nextTurn = async (history: ModelMessage[]) => {
    const next = new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ] satisfies LanguageModelV3StreamPart[]),
        },
      ],
    })
    const r = streamText({ model: next, messages: [...history, { role: 'user', content: 'go on' }], stopWhen: stepCountIs(2) })
    const failed = await r.consumeStream().then(() => r.steps).then(() => '', (e: Error) => e.name)
    return failed || `${next.doStreamCalls.length} request`
  }
  const cutAsked = [{ role: 'user' as const, content: 'build it' }, ...cutCallMessages]
  const unrepaired = await nextTurn(cutAsked)
  const repaired = await nextTurn([...cutAsked, ...cutRepair, { role: 'user', content: cutOffNote(await cutCallSdk.steps, 64_000)! }])
  check(
    unrepaired !== '1 request' && repaired === '1 request',
    `cut: the next turn goes out with the result stored, and did not without it -> with ${repaired}, without ${unrepaired}`,
  )
  await rm(cutDir, { recursive: true, force: true })
})

test('the step limit: the turn says it stopped, instead of ending mid-work', async () => {
  // A model that always has another tool to call, stopped by stepCountIs as chat() stops it.
  let busyN = 0
  const busyStep = () =>
    convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: `n${++busyN}`, toolName: 'noop', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ] satisfies LanguageModelV3StreamPart[])
  const busy = streamText({
    model: new MockLanguageModelV3({ doStream: [{ stream: busyStep() }, { stream: busyStep() }, { stream: busyStep() }] }),
    prompt: 'build it',
    tools: { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) },
    stopWhen: stepCountIs(3),
  })
  await busy.consumeStream()
  const busySteps = await busy.steps
  const spent = outOfStepsNote(busySteps, 3)
  check(
    busySteps.length === 3 && spent?.startsWith('⚠ The builder used all 3 steps') === true && outOfStepsNote(busySteps, 4) === null,
    `steps: a turn stopped by the limit says so, and one under it does not -> ${busySteps.length} steps, ${spent?.slice(0, 48)}`,
  )
  check(
    outOfStepsNote([{ finishReason: 'tool-calls', toolCalls: [{ toolName: 'ask_user' }] }], 1) === null &&
      outOfStepsNote([{ finishReason: 'stop', toolCalls: [] }], 1) === null,
    'steps: not when the last step asked a question, or finished on its own',
  )
  // chat() calls it with its own MAX_STEPS, the backstop behind the budget.
  const writes = (n: number) => Array.from({ length: n }, () => ({ finishReason: 'tool-calls', toolCalls: [{ toolName: 'write_file' }] }))
  check(
    outOfStepsNote(writes(100))?.includes('all 100 steps') === true && outOfStepsNote(writes(99)) === null,
    `steps: the backstop is 100 steps -> ${outOfStepsNote(writes(100))?.slice(0, 36)}`,
  )
})

test('the budget: a message stops on what it spent, and says so', async () => {
  // Steps at $0.30 against $1, under the condition chat() gives streamText with no look spent.
  const paid = streamText({
    model: new MockLanguageModelV3({ doStream: async () => ({ stream: paidStep() }) }),
    prompt: 'build it',
    tools: noop,
    stopWhen: [stepCountIs(100), ({ steps }) => costOf(steps) >= 1],
  })
  await paid.consumeStream()
  const paidSteps = await paid.steps
  const broke = overBudgetNote(paidSteps, costOf(paidSteps), 1)
  check(
    paidSteps.length === 4 && broke?.startsWith('⚠ The builder spent $1.20 of the $1 one message may spend') === true,
    `budget: $0.30 steps against $1 stop after the 4th, and say so -> ${paidSteps.length} steps, ${broke?.slice(0, 60)}`,
  )
  check(
    overBudgetNote(paidSteps.slice(0, 3), costOf(paidSteps.slice(0, 3)), 1) === null &&
      overBudgetNote([{ finishReason: 'tool-calls', toolCalls: [{ toolName: 'ask_user' }] }], 2, 1) === null &&
      overBudgetNote([{ finishReason: 'stop', toolCalls: [] }], 2, 1) === null,
    'budget: no note under it, or when the last step asked or finished on its own',
  )
  check(overBudgetNote(paidSteps, 0.6, 0.5)?.includes('of the $0.50 one message') === true, 'budget: $0.50 said as $0.50')
})

test("chat.json after every step: step 1 is on disk before step 2's request goes", async () => {
  const keepPath = join(TMP, 'keep-check', '.apps-builder', 'chat.json')
  let keepN = 0
  let onDisk: ModelMessage[] = []
  const keepRun = streamText({
    model: new MockLanguageModelV3({
      doStream: async () => {
        if (++keepN === 2) onDisk = await Bun.file(keepPath).json()
        return {
          stream:
            keepN === 1
              ? paidStep()
              : convertArrayToReadableStream([
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: 'built' },
                  { type: 'text-end', id: 't' },
                  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
                ] satisfies LanguageModelV3StreamPart[]),
        }
      },
    }),
    messages: [{ role: 'user', content: 'build it' }],
    tools: noop,
    stopWhen: stepCountIs(5),
    onStepEnd: keepSteps(keepPath, [{ role: 'user', content: 'build it' }]),
  })
  await keepRun.consumeStream()
  const keptAll = (await Bun.file(keepPath).json()) as ModelMessage[]
  check(
    onDisk.map((m) => m.role).join() === 'user,assistant,tool' && keptAll.map((m) => m.role).join() === 'user,assistant,tool,assistant',
    `keep: step 1, its call and its result, on disk before step 2 ran; both after -> ${onDisk.map((m) => m.role)} / ${keptAll.map((m) => m.role)}`,
  )
  await rm(join(TMP, 'keep-check'), { recursive: true, force: true })
})

test('the claim: one writer per project', async () => {
  let during = false
  const [first, second] = await Promise.allSettled([
    claimed('claim-check', 'busy', async () => {
      during = running('claim-check')
      await Bun.sleep(30)
      return 'done'
    }),
    claimed('claim-check', 'busy', async () => 'also'),
  ])
  check(
    first.status === 'fulfilled' && second.status === 'rejected' && (second.reason as { status?: number }).status === 409 && during && !running('claim-check'),
    'claim: a write under the turn\'s claim — a design route, a restore, a rename, a hand edit — refuses a second at once, and reads as running while it lasts',
  )
})


test("a failed turn: what it wrote is committed as its turn, not handed to the next as someone else's", async () => {
  const slug = 'failed-check'
  const dir = join(TMP, slug)
  await mkdir(join(dir, 'src'), { recursive: true })
  await Bun.write(join(dir, 'package.json'), '{}')
  await Bun.write(join(dir, 'src/Home.tsx'), 'template')
  await Bun.write(join(dir, '.apps-builder/project.json'), '{}')
  await Bun.spawn(['git', 'init', '-q'], { cwd: dir }).exited
  await checkpoint(dir, COMMIT.scaffold)

  // OpenRouter, faked where the provider reaches it: step 1 writes Home.tsx, and step 2's request
  // is refused with a 400, which the SDK does not retry, so the stream breaks off on an error.
  // The catalog is refused too, which a turn already lives without.
  const real = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.endsWith('/chat/completions')) return new Response('{"error":{"code":404}}', { status: 404 })
    if (++requests > 1) return Response.json({ error: { message: 'upstream refused', code: 400 } }, { status: 400 })
    const call = { index: 0, id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'src/Home.tsx', content: 'the app' }) } }
    const chunks = [
      { id: 'g', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] },
      { id: 'g', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  let events = ''
  try {
    events = await new Response(await chat(slug, 'a tip splitter')).text()
  } finally {
    globalThis.fetch = real
  }
  const git = (...a: string[]) => Bun.spawnSync(['git', ...a], { cwd: dir }).stdout.toString().trim()
  check(requests === 2 && events.includes('"type":"error"'), `failed: the second request refused, the turn ends on its error -> ${requests} requests`)
  check(
    git('log', '-1', '--format=%s') === 'turn 1 (failed): a tip splitter' && git('show', 'HEAD:src/Home.tsx') === 'the app',
    `failed: the write it made is in a commit of its own turn -> ${git('log', '-1', '--format=%s')}`,
  )
  check((await readMeta(slug)).turns === 1, 'failed: and the tally counts it, so the next turn is turn 2')
  check((await noteOutsideEdits(dir)) === null, 'failed: the next turn is not told that its own write was made outside the chat')
  await rm(dir, { recursive: true, force: true })
})

test("a spec or plan of another shape, or broken JSON, reads as none: the Artefacts pane draws, /artefacts answers", async () => {
  const slug = 'odd-artefacts'
  const dir = join(TMP, slug)
  await mkdir(join(dir, '.apps-builder'), { recursive: true })
  await Bun.write(join(dir, 'package.json'), '{}')
  await Bun.write(join(dir, '.apps-builder/spec.json'), '{"name": "no personas"}')
  await Bun.write(join(dir, '.apps-builder/plan.json'), '{"steps": 3')
  const view = await artefacts(slug).catch((e: Error) => e.message)
  check(typeof view === 'object' && view.spec === null && view.plan === null, `spec and plan read as none -> ${JSON.stringify(view)}`)
  // A spec saved before `layouts` existed (tetris, 2026-09-25) is still a spec: the pane allows for it.
  const old = { summary: 's', personas: [{ name: 'n', goal: 'g' }], design: 'd', screens: [{ name: 'a', purpose: 'p' }], edgeCases: [] }
  await Bun.write(join(dir, '.apps-builder/spec.json'), JSON.stringify(old))
  check((await artefacts(slug)).spec?.summary === 's', 'a spec without layouts reads as itself')
  await rm(dir, { recursive: true, force: true })
})

test("a card's answer to a question no longer open is refused, before anything is sent or committed", async () => {
  // A second tab's card, or one left on screen after its question was answered: its Go would approve
  // whatever question is open now (a later plan step), and spend on it.
  const slug = 'stale-card'
  const dir = join(TMP, slug)
  await mkdir(join(dir, '.apps-builder'), { recursive: true })
  await Bun.write(join(dir, 'package.json'), '{}')
  await Bun.write(join(dir, '.apps-builder/project.json'), '{}')
  const asking = (id: string) => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'ask_user', input: { questions: [] } }] })
  await Bun.write(join(dir, '.apps-builder/chat.json'), JSON.stringify([{ role: 'user', content: 'a tip splitter' }, asking('new-id')]))
  const real = globalThis.fetch
  let requests = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input instanceof Request ? input.url : input).endsWith('/chat/completions')) requests++
    return new Response('{"error":{"code":404}}', { status: 404 })
  }) as typeof fetch
  try {
    const refused = await chat(slug, 'Go', 'old-id').then(() => null, (e: { status?: number }) => e.status)
    check(refused === 409 && requests === 0 && !running(slug), `a stale card's answer -> ${refused}, ${requests} model requests`)
  } finally {
    globalThis.fetch = real
    await rm(dir, { recursive: true, force: true })
  }
})
