/**
 * A turn's stream as the server sends it: what the live bubble says the model is doing, the
 * reasoning paced out and flushed, live and reloaded agreeing through the real streamText over
 * a mock model, a stream stopped or broken mid-reasoning, and the trace line of a step.
 */
import { test } from 'bun:test'
import { stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { EVERY_MS } from '../server/activity'
import { stepLine } from '../server/trace'
import { toTurns } from '../src/turns'
import { tail } from '../src/thoughts'
import { R1, R2, check, folded, reasoning, relayed, replay, replyOf, textOf, thoughtsOf, usage } from './fixtures'

test('what the live bubble says the model is doing', async () => {
  // The part order is GLM's, as recorded 2026-09-23: reasoning closes after the step's
  // tool calls, not before them. `run` is check_app's own execute() starting, which the
  // SDK does only once the message has finished streaming. replay() feeds every part through
  // paceOf, the wiring agent.ts runs, and logs the trace and the tracker in one line.
  const rambling = Array.from({ length: 80 }, (_, i) => `word${i}`).join('\n')
  const glm = replay([
    [0, { type: 'reasoning-start' }],
    [100, { type: 'reasoning-delta', text: 'Let me look ' }],
    [300, { type: 'reasoning-delta', text: 'at the files.' }],
    [310, { type: 'tool-input-start', toolName: 'check_app' }],
    [310, { type: 'tool-call', toolName: 'check_app', input: { path: '/', viewport: 'mobile' } }],
    [320, { type: 'reasoning-end' }],
    [330, { type: 'run', toolName: 'check_app', input: { path: '/', viewport: 'mobile' } }],
    [9000, { type: 'tool-result' }],
    [9000, { type: 'finish-step' }],
    [9500, { type: 'reasoning-start' }],
    [9800, { type: 'reasoning-delta', text: rambling }],
    [9900, { type: 'reasoning-end' }],
    [9900, { type: 'text-start' }],
    [9900, { type: 'text-delta', text: 'Done.' }],
    [9950, { type: 'finish-step' }],
    [9950, { type: 'finish' }],
  ])
  check(
    glm.log.join(', ') ===
      'thought fresh, thinking, thought, writing check_app, writing, running check_app / · mobile, waiting, thought fresh, thinking, writing, waiting, saving',
    `activity: the phases and the thoughts in order -> ${glm.log.join(', ')}`,
  )
  check(
    glm.said.every((a) => a.doing !== 'thinking' || a.what === undefined),
    'activity: thinking carries no text; the reasoning goes as thoughts',
  )
  check(
    JSON.stringify(thoughtsOf(folded(glm.sent.map((t) => ({ type: 'thought', ...t }))))) ===
      JSON.stringify(['Let me look at the files.', rambling]),
    'trace: folded, the thoughts are each step\'s reasoning whole, newlines kept',
  )
  const tailSaid = tail(rambling)
  check(
    tailSaid.length === 293 && tailSaid.startsWith('word38') && tailSaid.endsWith('word79') && !tailSaid.includes('\n'),
    `tail: long reasoning shows as its tail, on one line, from a word (${tailSaid.length} chars)`,
  )

  // The first step's first delta goes at once; the next only once 250 ms have passed since
  // the last send; and whatever is held goes out before the news that ended it.
  const paced = replay([
    [0, { type: 'reasoning-start' }],
    [0, { type: 'reasoning-delta', text: 'a' }],
    [100, { type: 'reasoning-delta', text: 'b' }],
    [300, { type: 'reasoning-delta', text: 'c' }],
    [310, { type: 'reasoning-delta', text: 'd' }],
    [320, { type: 'abort' }],
  ])
  check(
    paced.log.join(', ') === 'thought fresh, thinking, thought, thought, saving' &&
      JSON.stringify(paced.sent) === '[{"text":"a","fresh":true},{"text":"bc"},{"text":"d"}]',
    `trace: first at once, then paced, then flushed before the stop -> ${paced.log.join(', ')} ${JSON.stringify(paced.sent)}`,
  )
  // The throttle alone would hold this one. Step 2's first delta arrives 40 ms after step
  // 1's only send, and if it were held, the client would show step 1's tail under step 2's
  // "thinking" until the next send.
  const quick = replay([
    [0, { type: 'reasoning-start' }],
    [0, { type: 'reasoning-delta', text: 'A' }],
    [10, { type: 'tool-call' }],
    [20, { type: 'finish-step' }],
    [30, { type: 'reasoning-start' }],
    [40, { type: 'reasoning-delta', text: 'B' }],
  ])
  check(
    quick.log.join(', ') === 'thought fresh, thinking, writing, waiting, thought fresh, thinking' &&
      JSON.stringify(quick.sent) === '[{"text":"A","fresh":true},{"text":"B","fresh":true}]',
    `trace: a later step's first delta goes at once too, 40 ms after the last send -> ${quick.log.join(', ')} ${JSON.stringify(quick.sent)}`,
  )

  // One step of 300 deltas every 33 ms, a paragraph break every tenth: the rate GLM streams at.
  const words = Array.from({ length: 300 }, (_, i) => `w${i}${i % 10 === 9 ? '\n\n' : ' '}`)
  const volume = replay([
    [0, { type: 'reasoning-start' }],
    ...words.map((text, i) => [33 * i, { type: 'reasoning-delta', text }] as const),
    [9900, { type: 'reasoning-end' }],
  ])
  check(
    volume.sent.length === 39 &&
      volume.at.slice(0, -1).join() === Array.from({ length: 38 }, (_, k) => 33 * 8 * k).join(),
    `trace: 300 deltas in 10 s go as ${volume.sent.length} sends, every 8th delta and one at the end`,
  )
  check(
    volume.sent[0]?.fresh === true && volume.sent.filter((t) => t.fresh).length === 1,
    'trace: only the step\'s first send opens a step',
  )
  check(volume.sent.map((t) => t.text).join('') === words.join(''), 'trace: and together they are every byte, in order')
  check(
    volume.at.slice(1, -1).every((t, k) => t - volume.at[k]! >= 250),
    'trace: at least 250 ms between sends, except the flush at the end',
  )
  check(
    volume.said.map((a) => a.doing).join(', ') === 'thinking, writing',
    `activity: a long think is one "thinking" -> ${volume.said.map((a) => a.doing).join(', ')}`,
  )

  const boundaries = ['reasoning-end', 'text-start', 'tool-input-start', 'tool-call', 'finish-step', 'abort', 'finish', 'error']
  const leaky = boundaries.filter(
    (type) =>
      JSON.stringify(
        replay([
          [0, { type: 'reasoning-start' }],
          [0, { type: 'reasoning-delta', text: 'a' }],
          [10, { type: 'reasoning-delta', text: 'b' }],
          [20, { type }],
        ]).sent,
      ) !== '[{"text":"a","fresh":true},{"text":"b"}]',
  )
  check(leaky.length === 0, `trace: every other part sends what is held before it${leaky.length ? ` — not ${leaky.join(', ')}` : ''}`)
  const held = replay([
    [0, { type: 'reasoning-start' }],
    [0, { type: 'reasoning-delta', text: 'a' }],
    [10, { type: 'reasoning-delta', text: 'b' }],
  ])
  held.end()
  const flushed = JSON.stringify(held.sent)
  held.end()
  check(
    flushed === '[{"text":"a","fresh":true},{"text":"b"}]' && held.sent.length === 2,
    'trace: end() sends what is held, and a second one sends nothing',
  )
  // The timer agent.ts runs, through paceOf: a tick sends what the throttle held with no
  // part after it, which is GLM's 12–19 s write_file silence; end() sends the rest and
  // stops the timer, so a tick after it, which would land after `done`, sends nothing.
  const timed = replay([
    [0, { type: 'reasoning-start' }],
    [0, { type: 'reasoning-delta', text: 'a' }],
    [10, { type: 'reasoning-delta', text: 'b' }],
    [250, { type: 'tick' }],
    [260, { type: 'reasoning-delta', text: 'c' }],
  ])
  const ticked = JSON.stringify(timed.sent)
  timed.end()
  const ended = JSON.stringify(timed.sent)
  timed.tick()
  check(
    ticked === '[{"text":"a","fresh":true},{"text":"b"}]' &&
      ended === '[{"text":"a","fresh":true},{"text":"b"},{"text":"c"}]' &&
      timed.sent.length === 3 &&
      !timed.ticking() &&
      timed.ticks.join() === String(EVERY_MS),
    `trace: the timer sends what is held, end() the rest, and stops it -> ${ended}, every ${timed.ticks.join()} ms, ${timed.ticking() ? 'still ticking' : 'stopped'}`,
  )

  // A step whose reasoning stays empty takes no entry live, as toTurns skips its `""`, and
  // never reads as thinking.
  const blank = replay([
    [0, { type: 'reasoning-start' }],
    [0, { type: 'reasoning-delta', text: '' }],
    [0, { type: 'tool-call' }],
    [0, { type: 'reasoning-end' }],
    [0, { type: 'finish-step' }],
    [10, { type: 'reasoning-start' }],
    [10, { type: 'reasoning-delta', text: 'B' }],
    [20, { type: 'finish-step' }],
  ])
  check(
    JSON.stringify(blank.sent) === '[{"text":"B","fresh":true}]',
    `trace: an empty reasoning part sends nothing -> ${JSON.stringify(blank.sent)}`,
  )
  check(
    blank.said.map((a) => a.doing).join(', ') === 'writing, waiting, thinking, waiting',
    `activity: and never says thinking -> ${blank.said.map((a) => a.doing).join(', ')}`,
  )
  // The timer flushes whether or not anything is held, and a step can open on an empty
  // delta. Neither may use up the step's `fresh` before its first word, or the client folds
  // this step into the last one and the live trace has a step fewer than the reload. The
  // `blank` replay above cannot tell, because step 2's reasoning-start re-arms it.
  const armed = (['reasoning-delta', 'tick'] as const).filter((type) => {
    const r = replay([
      [0, { type: 'reasoning-start' }],
      [0, { type: 'reasoning-delta', text: 'A' }],
      [10, { type: 'finish-step' }],
      [500, { type: 'reasoning-start' }],
      [500, { type, text: '' }],
      [800, { type: 'reasoning-delta', text: 'B' }],
    ])
    return JSON.stringify(r.sent) !== '[{"text":"A","fresh":true},{"text":"B","fresh":true}]'
  })
  check(
    armed.length === 0,
    `trace: an empty flush before a step's first word leaves it opening a step${armed.length ? ` — not after ${armed.join(', ')}` : ''}`,
  )

  // Stop: `ai` 7 ends the stream with `abort` and never sends `finish`, and the turn still
  // saves and commits what it did.
  const halted = replay([
    [0, { type: 'reasoning-start' }],
    [0, { type: 'reasoning-delta', text: 'Hmm' }],
    [0, { type: 'abort' }],
  ])
  check(
    halted.said.map((a) => a.doing).join(', ') === 'thinking, saving',
    `activity: a stopped turn says saving, not the step it was stopped in -> ${halted.said.map((a) => a.doing).join(', ')}`,
  )
  check(JSON.stringify(halted.sent) === '[{"text":"Hmm","fresh":true}]', 'trace: and its reasoning went out before it')
})

test("live and reloaded agree, through the server's own loop", async () => {
  // A mock model behind the real streamText, so the SDK itself builds both sides: the
  // fullStream that relay(), chat()'s own loop, turns into events, and the steps it persists
  // to chat.json. The reasoning is streamed a character at a time with an empty delta in it,
  // with whitespace at both ends and a blank line inside. One step ends on a tool call after
  // GLM's fashion, straight out of its reasoning and with the reasoning closed behind it.
  // Both steps say something, so the text is held to its reload as well.
  const sdk = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Reading it.' },
            { type: 'text-end', id: 't1' },
            { type: 'reasoning-start', id: 'r1' },
            ...reasoning('r1', R1),
            { type: 'reasoning-delta', id: 'r1', delta: '' },
            { type: 'tool-call', toolCallId: 'c', toolName: 'noop', input: '{}' },
            { type: 'reasoning-end', id: 'r1' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        },
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r2' },
            ...reasoning('r2', R2),
            { type: 'reasoning-end', id: 'r2' },
            { type: 'text-start', id: 't2' },
            { type: 'text-delta', id: 't2', delta: 'Done.' },
            { type: 'text-end', id: 't2' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ]),
        },
      ],
    }),
    prompt: 'make it blue',
    tools: { noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }) },
    stopWhen: stepCountIs(5),
  })
  const whole = await relayed(sdk.fullStream)
  const persisted = toTurns(JSON.parse(JSON.stringify((await sdk.steps).flatMap((s) => s.response.messages))))
  // Loudly, so a malformed fixture cannot pass by streaming nothing.
  check(
    whole.error === undefined && whole.aborted === false,
    `sdk: relay() ran the mock's stream to its end${whole.error ? ` (${String(whole.error)})` : ''}`,
  )
  check(
    JSON.stringify(whole.thoughts) === JSON.stringify([R1, R2]),
    `sdk: the thoughts it sent are each step's reasoning, raw -> ${JSON.stringify(whole.thoughts)}`,
  )
  check(
    JSON.stringify(thoughtsOf(persisted[0])) === JSON.stringify(whole.thoughts),
    `sdk: and what chat.json stored reloads to the same -> ${JSON.stringify(thoughtsOf(persisted[0]))}`,
  )
  check(
    whole.text === textOf(persisted[0]),
    `sdk: so does the text, a paragraph between its steps -> ${JSON.stringify(whole.text)}`,
  )
  check(
    JSON.stringify(whole.flow) === JSON.stringify(replyOf(persisted[0])?.flow) &&
      JSON.stringify(whole.flow.map((s) => s.kind)) === '["text","thought","tools","thought","text"]',
    `sdk: and the flow, live and reloaded, in the stream's order -> ${JSON.stringify(whole.flow.map((s) => s.kind))}`,
  )
  // Activity left out, and repeats run together.
  check(
    whole.order === 'text, thought, tool, thought, text, done' && !whole.ticking,
    `sdk: each step's reasoning goes before its text and rows, nothing after done, the timer stopped -> ${whole.order}${whole.ticking ? ', still ticking' : ''}`,
  )
})

test('a stop mid-reasoning, and a stream that breaks mid-reasoning', async () => {
  // Stop, mid-reasoning. `ai` 7 answers the abort with an `abort` part and ends the stream,
  // a couple of parts after the one it was stopped on, and every delta relay() was handed
  // goes out before `done`.
  const halt = new AbortController()
  const handed: string[] = []
  const midStop = await relayed(
    streamText({
      abortSignal: halt.signal,
      model: new MockLanguageModelV3({
        doStream: [
          {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'reasoning-start', id: 'r' },
              ...reasoning('r', R1),
              { type: 'reasoning-end', id: 'r' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ]),
          },
        ],
      }),
      prompt: 'make it blue',
    }).fullStream,
    (p) => {
      if (p.type !== 'reasoning-delta') return
      handed.push(p.text)
      if (p.text === ':') halt.abort()
    },
  )
  check(
    midStop.aborted === true &&
      JSON.stringify(midStop.thoughts) === JSON.stringify([handed.join('')]) &&
      handed.join('') !== R1 &&
      midStop.order === 'thought, done' &&
      !midStop.ticking,
    `sdk: a stop mid-reasoning reports the turn stopped, every delta it was handed sent -> aborted ${midStop.aborted}, ${JSON.stringify(midStop.thoughts)}, ${midStop.order}`,
  )

  // A stream that breaks mid-reasoning, with its last delta still held by the throttle. A
  // provider that goes away rejects the SDK's stream rather than sending an `error` part; an
  // `error` part is rethrown here; a timeout is thrown too, and is a stop, not a failure.
  // Every way, what was held goes out before chat() sends `error` or `done`, and nothing
  // after it.
  const cutOff = (end: (c: ReadableStreamDefaultController) => void) => {
    let now!: () => void
    return relayed(
      streamText({
        model: new MockLanguageModelV3({
          doStream: async () => ({
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'stream-start', warnings: [] })
                c.enqueue({ type: 'reasoning-start', id: 'r' })
                c.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'a' })
                c.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'b' })
                // Only once relay() has been handed 'b': an errored stream drops what it holds.
                void new Promise<void>((r) => (now = r)).then(() => end(c))
              },
            }),
          }),
        }),
        prompt: 'make it blue',
        onError: () => {},
      }).fullStream,
      (p) => {
        if (p.type === 'reasoning-delta' && p.text === 'b') now()
      },
    )
  }
  const endings = [
    ['a provider that hangs up', (c) => c.error(new Error('socket hang up')), 'Error: socket hang up, thought, error'],
    ['an error part', (c) => (c.enqueue({ type: 'error', error: new Error('rate limited') }), c.close()), 'Error: rate limited, thought, error'],
    ['a timeout', (c) => c.error(new DOMException('The operation timed out.', 'TimeoutError')), 'stopped, thought, done'],
  ] satisfies [string, (c: ReadableStreamDefaultController) => void, string][]
  const misended: string[] = []
  for (const [what, end, want] of endings) {
    const r = await cutOff(end)
    const got = `${r.error ? String(r.error) : r.aborted ? 'stopped' : 'finished'}, ${r.order}${r.ticking ? ', still ticking' : ''}`
    if (got !== want || JSON.stringify(r.thoughts) !== '["ab"]') misended.push(`${what}: ${got} ${JSON.stringify(r.thoughts)}`)
  }
  check(
    misended.length === 0,
    `sdk: a stream that breaks mid-reasoning sends what it held before the error, a timeout before done${misended.length ? ` — not ${misended.join('; ')}` : ''}`,
  )
})

test('the trace: one line per request, with what OpenRouter says of it', async () => {
  // A step as the SDK builds it from a stream: the generation id, the model served, the
  // provider and the cost; an edit refused, a write that threw and an edit cut off mid-JSON
  // (tool-error parts, no result), and two check_apps whose browser half says "no errors" —
  // one of them with a type error, which is not clean, and a page whose text reads like a
  // failed step, a type error and a failed look, which is not the report's.
  const traceRun = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'gen-1', modelId: 'z-ai/glm-5.3-20260816' },
            { type: 'tool-call', toolCallId: 'e', toolName: 'edit_file', input: JSON.stringify({ path: 'src/A.tsx', old_string: 'x', new_string: 'y' }) },
            { type: 'tool-call', toolCallId: 'c', toolName: 'check_app', input: JSON.stringify({ path: '/' }) },
            { type: 'tool-call', toolCallId: 'w', toolName: 'write_file', input: JSON.stringify({ path: 'node_modules/x.js', content: '' }) },
            { type: 'tool-call', toolCallId: 'x', toolName: 'edit_file', input: '{"path":"src/B.tsx","old_str' },
            { type: 'tool-call', toolCallId: 'k', toolName: 'check_app', input: JSON.stringify({ path: '/ok' }) },
            {
              type: 'finish',
              finishReason: { unified: 'tool-calls', raw: undefined },
              usage,
              providerMetadata: { openrouter: { provider: 'Wafer', usage: { cost: 0.012 } } },
            },
          ] satisfies LanguageModelV3StreamPart[]),
        },
      ],
    }),
    prompt: 'build it',
    tools: {
      edit_file: tool({ inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }), execute: async () => 'Not written, nothing changed in src/A.tsx: old_string is not in the file.' }),
      check_app: tool({
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) =>
          `typecheck: ${path === '/' ? '\nsrc/A.tsx(1,1): error TS2304: x' : 'clean'}\npreview: http://127.0.0.1:1${path} → HTTP 200\n` +
          // The app's own words, which say what the report says and are not the report.
          'page:\n- paragraph: "1. Build — FAILED: error TS2322"\n- paragraph: we could not look (up) that city\nno errors',
      }),
      write_file: tool({ inputSchema: z.object({ path: z.string(), content: z.string() }), execute: async (): Promise<string> => { throw new Error('not a source file') } }),
    },
    stopWhen: stepCountIs(1),
  })
  await traceRun.consumeStream()
  const traceLine = stepLine((await traceRun.steps)[0]!, { run: 'r1', turn: 3, step: 1, model: '~z-ai/glm-latest', effort: 'high' })
  const [tracedEdit, tracedCheck, tracedWrite, tracedCut, tracedClean] = traceLine.tools
  check(
    traceLine.id === 'gen-1' && traceLine.served === 'z-ai/glm-5.3-20260816' && traceLine.provider === 'Wafer' && traceLine.usd === 0.012 &&
      traceLine.tokens.input === 1 && traceLine.finish === 'tool-calls' && traceLine.effort === 'high' && typeof traceLine.ms.step === 'number',
    `trace.jsonl: a step line has its generation id, the model served, provider, cost, tokens and times -> ${JSON.stringify({ ...traceLine, tools: undefined })}`,
  )
  check(
    tracedEdit?.name === 'edit_file' && tracedEdit.path === 'src/A.tsx' && tracedEdit.refused === true && typeof tracedEdit.ms === 'number' &&
      tracedEdit.error === undefined && tracedCheck?.refused === undefined && tracedCheck?.flags?.join() === 'type-error',
    `trace.jsonl: and its tools — the edit refused, the check's type error flagged and not clean -> ${JSON.stringify(traceLine.tools)}`,
  )
  check(
    tracedWrite?.error === true && tracedWrite.path === 'node_modules/x.js' && tracedCut?.name === 'edit_file' && tracedCut.error === true &&
      tracedClean?.error === undefined && tracedClean?.flags?.join() === 'clean',
    `trace.jsonl: a call that threw or would not parse is an error, and a check clean in both halves is clean -> ${JSON.stringify(traceLine.tools.slice(2))}`,
  )
})

