/**
 * A project's model settings, checked where they can silently go wrong: in the request body
 * OpenRouter receives, and in project.json across racing writes and reads. No server, no
 * model, no paid call — the body is read off a stub `fetch`.
 *
 * The body is the point. Every layer here drops a misplaced setting without a word: AI SDK
 * 7's `reasoning` option never reaches OpenRouter through this provider, OpenRouter ignores
 * what a model does not support, and the provider always reports `warnings: []`.
 */
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'bun:test'
import { type ModelMessage, generateText } from 'ai'
import { cutOffNote } from '../server/agent'
import { DEFAULT_MODEL, loopModel, outputLimit } from '../server/model'
import { checkpoint } from '../server/git'
import { listProjects } from '../server/previews'
import { readMeta, updateMeta } from '../server/project'
import { type Effort, buildEffort, cleanParams, paramsPatch, requestBody, sentWindow } from '../shared/params'
import { answer, reasonedFrom, unreasoned } from '../shared/ask'
import { settingsPatch } from '../shared/settings'
import { type Model, buildEffortOf, defaultEffort, thinkings, unfit, windowOf } from '../shared/models'
import { TMP, check } from './fixtures'

/** The JSON body one call would have sent. The stub refuses, so the call itself fails. */
async function bodyFor(
  params: Parameters<typeof loopModel>[1],
  messages: ModelMessage[] = [{ role: 'user', content: 'hi' }],
  full?: number,
  id = 'z-ai/glm-5.3-flash',
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {}
  const stub = (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    throw new Error('stub: not sending')
  }) as unknown as typeof fetch
  await generateText({ model: loopModel(id, params, full, stub), messages, maxRetries: 0 }).catch(() => {})
  return body
}

const refuses = (v: unknown, clean: (v: unknown) => unknown = cleanParams) => {
  try {
    clean(v)
    return false
  } catch {
    return true
  }
}

// Catalog entries as OpenRouter gave them on 2026-09-25, reduced to what Thinking reads.
const entry = (id: string, reasoning: Model['reasoning']): Model => ({
  id, ctx: 0, prompt: 0, completion: 0, image: false, supported: new Set(['reasoning']), maxOut: null, defaults: {}, reasoning,
})
const glm = entry('z-ai/glm-5.3-flash', { mandatory: true, default_enabled: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'max' })

test('request body', async () => {
  const none = await bodyFor({})
  check(!('reasoning' in none) && !('temperature' in none), 'nothing set: no reasoning, no temperature — the model decides')
  check((none.usage as { include?: boolean })?.include === true, 'cost accounting (usage) still sent')
  check((none.cache_control as { ttl?: string })?.ttl === '1h', 'prompt caching (cache_control) still sent')
  check(
    (none.provider as { sort?: string })?.sort === 'price',
    `routed in price order, so the next request goes to the same provider: ${JSON.stringify(none.provider)}`,
  )

  // The house model's quality was judged at fp8; 71% of dev's GLM-5.3 requests went to fp4 providers,
  // which the price sort reaches first (2026-10-22). Only the house model: some serve only fp4/int4.
  const house = (await bodyFor({}, undefined, undefined, DEFAULT_MODEL)).provider as { sort?: string; quantizations?: string[] }
  check(house.sort === 'price' && JSON.stringify(house.quantizations) === '["fp8","bf16","fp16"]', `the house model never fp4: ${JSON.stringify(house)}`)
  check(!('quantizations' in (none.provider as object)), 'any other model, any quantization')

  const set = await bodyFor({ effort: 'max', temperature: 0.2, min_p: 0.05, repetition_penalty: 1.1, seed: 7, top_k: 40 })
  check(JSON.stringify(set.reasoning) === '{"enabled":true,"effort":"max"}', `effort max goes out as reasoning.effort: ${JSON.stringify(set.reasoning)}`)
  check(set.temperature === 0.2 && set.top_k === 40 && set.seed === 7, 'SDK-known knobs keep their values')
  check(set.min_p === 0.05 && set.repetition_penalty === 1.1, 'OpenRouter-only knobs (min_p, repetition_penalty) are in the body')

  // Output limit. Unsent, OpenRouter filled in 65,536 for Claude, which can write 128,000, and a
  // Sonnet at xhigh thought for all of it without reaching a tool call (running-fox, 2026-09-29).
  check(!('max_tokens' in none), 'no limit known: max_tokens not sent — OpenRouter picks, as before')
  const capped = await bodyFor({}, undefined, 128_000)
  check(capped.max_tokens === 128_000, `a known limit goes out as max_tokens: ${capped.max_tokens}`)
  const below = (await bodyFor({ max_tokens: 64_000 }, undefined, 128_000)).max_tokens
  const above = (await bodyFor({ max_tokens: 512_000 }, undefined, 128_000)).max_tokens
  const unknown = (await bodyFor({ max_tokens: 64_000 })).max_tokens
  check(
    below === 64_000 && above === 128_000 && unknown === 64_000,
    `the project's Thinking window goes out as max_tokens, within the model's: 64k of 128k -> ${below}, 512k of 128k -> ${above}, 64k of unknown -> ${unknown}`,
  )
  check(!('max_tokens' in requestBody({ max_tokens: 64_000 })), 'and never through the body (extraBody), which would overwrite it')
  // Endpoints and the catalog as OpenRouter answered them on 2026-09-30, cut to what is read:
  // [max_completion_tokens, context_length, takes tools, status].
  type Row = [number | null, number, boolean?, number?]
  const endpoints: Record<string, Row[]> = {
    'z-ai/glm-5.3': [[131072, 1048576], [943718, 1048576], [128000, 980000], [235929, 262144]],
    'anthropic/claude-sonnet-5.5': [[128000, 1000000], [128000, 1000000], [128000, 1000000]],
    'openai/gpt-oss-120b': [[4096, 128000, false], [117964, 131072], [16384, 131072], [131072, 262144, true, -2]],
    'x-ai/grok-4.7': [[450000, 500000], [450000, 500000]],
    '~anthropic/claude-sonnet-latest': [],
    '~moonshotai/kimi-latest': [],
    'openrouter/auto': [],
    'x/unstated': [[null, 200000], [64000, 1000000]],
  }
  const asEndpoint = ([max_completion_tokens, context_length, tools = true, status = 0]: Row) => ({
    max_completion_tokens,
    context_length,
    status,
    supported_parameters: tools ? ['tools', 'max_tokens'] : ['max_tokens'],
  })
  let asked = 0
  const openrouter = (async (url: unknown) => {
    asked++
    const id = /\/models\/(.+)\/endpoints$/.exec(String(url))?.[1] ?? ''
    if (id === 'x/down') throw new Error('network down')
    if (!(id in endpoints)) return new Response('{"error":{"code":404}}', { status: 404 })
    return Response.json({ data: { id, endpoints: endpoints[id]!.map(asEndpoint) } })
  }) as unknown as typeof fetch
  const listed = async () =>
    [
      { id: '~anthropic/claude-sonnet-latest', maxOut: 128000, ctx: 1000000 },
      { id: '~moonshotai/kimi-latest', maxOut: 943718, ctx: 1048576 },
      { id: 'openrouter/auto', maxOut: null, ctx: 2000000 },
    ] as Model[]
  const limit = (id: string) => outputLimit(id, openrouter, listed)
  check((await limit('z-ai/glm-5.3')) === 524288, `GLM-5.3: its largest window, half its 1M context, so only providers that can write it serve -> ${await limit('z-ai/glm-5.3')}`)
  check((await limit('anthropic/claude-sonnet-5.5')) === 128000, 'Sonnet 5.5: 128,000, not the 65,536 OpenRouter filled in')
  check(
    (await limit('openai/gpt-oss-120b')) === 65536,
    `gpt-oss-120b: a small provider no longer sets it, nor one without tools (4,096) or down -> ${await limit('openai/gpt-oss-120b')}`,
  )
  check((await limit('x-ai/grok-4.7')) === 250000, `Grok 4.7: 450,000 of a 500,000 context would leave no room — half stays for the conversation -> ${await limit('x-ai/grok-4.7')}`)
  check((await limit('~anthropic/claude-sonnet-latest')) === 128000, 'an alias, which lists no providers: the catalog’s figures')
  check((await limit('~moonshotai/kimi-latest')) === 524288, 'and held to half the catalog’s context too')
  check((await limit('openrouter/auto')) === undefined, 'a router, with no figure anywhere: nothing')
  check((await limit('x/unstated')) === 100000, 'a provider that states no limit can write its context — half of it')
  check((await limit('x/missing')) === undefined && (await limit('x/down')) === undefined, 'a 404 or a network error: nothing, and the turn goes on')
  const before = asked
  await limit('z-ai/glm-5.3')
  await limit('x/down')
  check(asked === before + 1, `looked up once per model, but a failure is asked again next turn (${asked - before} new asks)`)
  await outputLimit('z-ai/glm-5.3', openrouter, listed, Date.now() + 11 * 60_000)
  check(asked === before + 2, 'and again after ten minutes: the window counts only the providers that are up')
  check(windowOf([]) === undefined && windowOf([asEndpoint([4096, 128000, false])]) === undefined, 'no provider that can serve a turn: no window')
  check(
    sentWindow(64_000, 524_288) === 64_000 && sentWindow(512_000, 128_000) === 128_000 && sentWindow(undefined, 128_000) === 128_000 &&
      sentWindow(64_000, undefined) === 64_000 && sentWindow(undefined, undefined) === undefined,
    'sent: the project’s window within the model’s, the model’s when unset, nothing when neither is known',
  )
  check(cutOffNote([{ finishReason: 'tool-calls' }, { finishReason: 'stop' }], 128000) === null, 'a turn that finished: no note')
  check(
    cutOffNote([{ finishReason: 'tool-calls' }, { finishReason: 'length' }], 128000)?.startsWith('⚠') === true &&
      cutOffNote([{ finishReason: 'length' }], 128000)!.includes('(128,000 tokens)') &&
      !cutOffNote([{ finishReason: 'length' }], undefined)!.includes('tokens)'),
    `a last reply cut at the limit: a ⚠ note, with the limit when it is known -> ${cutOffNote([{ finishReason: 'length' }], 128000)}`,
  )
  check(cutOffNote([{ finishReason: 'length' }, { finishReason: 'stop' }], 128000) === null, 'a cut earlier in the turn that the loop got past: no note')
  check(
    !cutOffNote([{ finishReason: 'length' }], 128000)!.includes('raise') && cutOffNote([{ finishReason: 'length' }], 64000, true)!.includes('raise the Thinking window'),
    'raising the Thinking window is told only when the project’s is below the model’s — the default is the largest',
  )

  // The effort a step is built at, against the efforts each model offered on 2026-09-30.
  const SONNET = ['max', 'xhigh', 'high', 'medium', 'low']
  const GLM = ['max', 'high', 'low']
  const table: [string | undefined, string[], string | undefined, string][] = [
    ['xhigh', SONNET, 'medium', 'Sonnet at xhigh builds at medium'],
    ['high', SONNET, 'medium', 'Sonnet at high — its default — builds at medium'],
    ['max', SONNET, 'medium', 'Sonnet at max builds at medium'],
    ['medium', SONNET, undefined, 'Sonnet at medium: no change'],
    ['low', SONNET, undefined, 'Sonnet at low: never raised'],
    ['max', GLM, 'high', 'GLM at max — its default — builds at high: it offers no medium, and low is below it'],
    ['high', GLM, undefined, 'GLM at high: no change'],
    ['on', SONNET, undefined, "'on' is not a level: no change"],
    ['none', SONNET, undefined, 'off stays off'],
    [undefined, SONNET, undefined, 'no effort known: no change'],
    ['xhigh', [], undefined, 'no efforts offered (no catalog): no change'],
  ]
  for (const [planned, offered, want, what] of table) {
    const got = buildEffort(planned, offered)
    check(got === want, `build effort: ${what} -> ${got}`)
  }

  const off = await bodyFor({ effort: 'none' })
  check(JSON.stringify(off.reasoning) === '{"enabled":false}', 'off goes out as reasoning.enabled false')

  const on = await bodyFor({ effort: 'on' })
  check(JSON.stringify(on.reasoning) === '{"enabled":true}', `on goes out as reasoning.enabled true, no effort: ${JSON.stringify(on.reasoning)}`)
})

test('history sent', async () => {
  // Past turns' reasoning, which the provider sends back twice and takes from a tool call's
  // providerOptions first. GLM's shape: the same details on the reasoning part and the call.
  // A detail exactly as GLM stores one: with `format`, or the provider takes it for Anthropic's,
  // finds no signature and drops it — and the reasoning with it.
  const details = (text: string) => ({
    openrouter: { reasoning_details: [{ type: 'reasoning.text', text, format: 'unknown', index: 0 }] },
  })
  const stepOf = (id: string, name: string, thought: string): ModelMessage => ({
    role: 'assistant',
    content: [
      { type: 'reasoning', text: thought, providerOptions: details(thought) },
      { type: 'tool-call', toolCallId: id, toolName: name, input: {}, providerOptions: details(thought) },
    ],
  })
  const resultOf = (id: string, name: string, value: string): ModelMessage => ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: id, toolName: name, output: { type: 'text', value } }],
  })
  const earlier: ModelMessage[] = [
    { role: 'user', content: 'a habit tracker' },
    stepOf('r', 'read_file', 'OLD THOUGHT'),
    resultOf('r', 'read_file', 'x'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'ONLY THOUGHT' }] },
    { role: 'user', content: 'and a history grid' },
    stepOf('q', 'ask_user', 'ASKING THOUGHT'),
  ]
  type Sent = { role: string; reasoning?: string; reasoning_details?: unknown; tool_calls?: unknown[] }
  /** What chat() sends for `message` after the stored `past`: an answer to its open question,
   *  or a new user turn — with the reasoning cut where the turn being continued starts. */
  const sent = async (past: ModelMessage[], message: string, model: string = DEFAULT_MODEL) => {
    const msgs = answer(past, message) ?? [...past, { role: 'user' as const, content: message }]
    return JSON.stringify(((await bodyFor({}, unreasoned(msgs, reasonedFrom(model, past)))).messages ?? []) as Sent[])
  }
  // A new message: every earlier turn is over, and none of its thinking goes.
  const fresh = await sent([...earlier, resultOf('q', 'ask_user', 'no preference')], 'go')
  check(
    !/THOUGHT/.test(fresh) && fresh.includes('"read_file"') && fresh.includes('"ask_user"'),
    `a new message: no earlier reasoning is sent, in either field, and the calls still are (${fresh.match(/THOUGHT/g)?.length ?? 0} left)`,
  )
  // An answer continues the turn that asked, whose thinking Anthropic wants back; the turn
  // before it is over. The step that only reasoned has nothing left, and is not sent at all.
  const answered = await sent(earlier, 'Me')
  check(
    answered.includes('ASKING THOUGHT') && !answered.includes('OLD THOUGHT') && !answered.includes('ONLY THOUGHT'),
    'an answer: the asking turn keeps its reasoning, the turns before it do not',
  )
  // A gated build, where every turn after the first is an answer and no user message comes
  // between them: only the message being answered keeps its thinking. Keeping it from the
  // turn's first prompt on kept the whole build's (measured on a real one: nothing was cut).
  const gated: ModelMessage[] = [
    { role: 'user', content: 'a habit tracker' },
    stepOf('a', 'ask_user', 'FIRST ASK'),
    resultOf('a', 'ask_user', 'Go'),
    stepOf('w', 'write_file', 'BUILDING'),
    resultOf('w', 'write_file', 'wrote'),
    stepOf('b', 'ask_user', 'SECOND ASK'),
  ]
  const gatedSent = await sent(gated, 'Go')
  check(
    gatedSent.includes('SECOND ASK') && !gatedSent.includes('FIRST ASK') && !gatedSent.includes('BUILDING'),
    `a gated build's answer: only the message it answers keeps its reasoning (${gatedSent.match(/FIRST ASK|BUILDING|SECOND ASK/g)?.join(', ')})`,
  )
  // Anthropic keeps them all: its cache write is paid, and a turn's first step re-wrote the whole stripped
  // history, 5-10x what the strip saved (dev's traces, 2026-10-22). The prefix it cached stays the prefix.
  const claude = await sent([...earlier, resultOf('q', 'ask_user', 'no preference')], 'go', 'anthropic/claude-x')
  check(claude.includes('OLD THOUGHT') && claude.includes('ASKING THOUGHT'), "an Anthropic model: every past turn's reasoning is sent")
  check(
    JSON.stringify(earlier[1]).includes('OLD THOUGHT'),
    'and the stored history is not changed: chat.json keeps every reasoning for the Thinking panels',
  )
})

test('validation', async () => {
  check(refuses({ temperature: 3 }), 'temperature 3 refused')
  check(refuses({ seed: 1.5 }), 'fractional seed refused')
  check(refuses({ effort: 'turbo' }), 'unknown effort refused')
  check(refuses({ usage: { include: false } }), 'a key outside the table (usage) refused — it would reach the body')
  check(refuses({ repetition_penalty: 0 }), 'repetition_penalty 0 refused — the penalty divides by it')
  check(cleanParams({ effort: 'on' }).effort === 'on', 'effort on accepted, though not on the effort scale')
  check(cleanParams({ max_tokens: 64_000 }).max_tokens === 64_000, 'a Thinking window accepted')
  for (const bad of [500, 64_000.5, '64000', 20_000_000]) check(refuses({ max_tokens: bad }), `Thinking window ${JSON.stringify(bad)} refused`)
  check(JSON.stringify(cleanParams({ top_p: 0.9, temperature: null })) === '{"top_p":0.9}', 'null clears a key')
  check(refuses({ top_p: 0.9, temperature: 3 }, paramsPatch), 'a PATCH’s params are checked the same way, before anything is written')
})

test('settings', async () => {
  // One check for every way a setting arrives: a PATCH, a create's `settings`, the start page's
  // draft (shared/settings.ts). A refusal is an Error the API turns into a 400.
  check(settingsPatch(null) === null && settingsPatch({ name: 'x' }) === null, 'no settings in the body: nothing to change')
  check(refuses('plan', settingsPatch) && refuses([], settingsPatch), 'settings that are not an object refused')
  check(refuses({ gate: 'sometimes' }, settingsPatch), 'gate "sometimes" refused')
  check(refuses({ design: 'yes' }, settingsPatch) && refuses({ model: 5 }, settingsPatch), 'design "yes", model 5 refused')
  check(refuses({ budget: 3 }, settingsPatch) && refuses({ budget: '2' }, settingsPatch) && refuses({ budget: 0 }, settingsPatch), 'a budget not in BUDGETS refused: 3, "2", 0')
  check(settingsPatch({ budget: 0.5 })!({}).budget === 0.5, 'a budget of $0.50 set')
  check(settingsPatch({ budget: 2 })!({ budget: 5 }).budget === undefined, 'the $2 default stored as absent, as design’s off is')
  check(
    refuses({ design: true, params: { temperature: 3 } }, settingsPatch),
    'one bad value refuses the whole change, before any of it applies',
  )
  const madeWith = settingsPatch({ model: ' z-ai/glm-5.3 ', gate: 'plan', design: true, params: { temperature: 0.3 } })!({})
  check(
    JSON.stringify(madeWith) === '{"model":"z-ai/glm-5.3","gate":"plan","design":true,"params":{"temperature":0.3}}',
    `a create's settings, the model trimmed -> ${JSON.stringify(madeWith)}`,
  )
  const back = settingsPatch({ design: false, model: '' })!({ design: true, model: 'x', gate: 'plan' })
  check(back.design === undefined && back.model === undefined && !('gate' in back), 'off and empty go back to the default, and an unnamed key is left alone')
  // Two quick changes, each applied to what the one before left: the draft's state updates.
  let draft = {}
  for (const change of [{ params: { temperature: 0.3 } }, { params: { top_k: 40 } }]) draft = { ...draft, ...settingsPatch(change)!(draft) }
  check(JSON.stringify(draft) === '{"params":{"temperature":0.3,"top_k":40}}', `params are a change, so both land -> ${JSON.stringify(draft)}`)
})

test('the panel', async () => {
  const deepseek = entry('deepseek/deepseek-v3.2', { mandatory: false, default_enabled: false })
  const sonnet = entry('anthropic/claude-sonnet-4.5', { mandatory: false })
  const opus = entry('anthropic/claude-opus-4.8', { mandatory: false, default_enabled: false, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' })
  // Build effort from the model's default, as chat() asks for it — Opus 4.6–4.8 list 'high' as
  // their default effort with reasoning off by default (catalog, 2026-09-30).
  const ALL: Effort[] = ['max', 'xhigh', 'high', 'medium', 'low']
  const opusOff = entry('anthropic/claude-opus-4.8', { mandatory: false, default_enabled: false, supported_efforts: ALL, default_effort: 'high' })
  const sonnet55 = entry('anthropic/claude-sonnet-5.5', { mandatory: true, supported_efforts: ALL, default_effort: 'high' })
  check(buildEffortOf(opusOff, undefined) === undefined, `Opus 4.8 at its default, off: built with reasoning still off, not at medium -> ${buildEffortOf(opusOff, undefined)}`)
  check(buildEffortOf(opusOff, 'xhigh') === 'medium', 'Opus 4.8 at xhigh, set by the person: built at medium')
  check(buildEffortOf(sonnet55, undefined) === 'medium', 'Sonnet 5.5 at its default, high: built at medium')
  check(buildEffortOf(glm, undefined) === 'high' && buildEffortOf(undefined, 'xhigh') === undefined, 'GLM at its default, max: built at high; a model the catalog does not list: as planned')
  check(paramsPatch(unfit(glm))({ max_tokens: 64_000 })?.max_tokens === undefined, 'a model switch clears the Thinking window, chosen against the last model’s providers')
  check(thinkings(deepseek).join() === 'on', `off by default, no efforts: on beside the default, no second off — ${thinkings(deepseek)}`)
  check(defaultEffort(sonnet) === 'unknown' && thinkings(sonnet).join() === 'on,none', `default not given: unknown, with on and off — ${thinkings(sonnet)}`)
  check(!thinkings(opus).includes('none'), 'efforts, off by default: no off beside default (off)')
  check(paramsPatch(unfit(glm))({ effort: 'none' })?.effort === undefined, 'a switch to GLM clears off, which it refuses')
  check(paramsPatch(unfit(glm))({ effort: 'low' })?.effort === 'low', 'and keeps an effort GLM offers')
  check(refuses({ effort: ['low', 'turbo'] }, paramsPatch), 'a switch’s effort list is checked like an effort')
  // A level the catalog lists before EFFORTS knows it.
  const future = entry('x/future', { mandatory: true, supported_efforts: ['turbo', 'high'] as Effort[] })
  check(thinkings(future).join() === 'high' && !refuses(unfit(future), paramsPatch), `an effort EFFORTS does not know is not offered, so a switch is not a 400 — ${thinkings(future)}`)
})

test('project.json', async () => {
  await mkdir(join(TMP, 'demo'), { recursive: true })
  await Bun.write(join(TMP, 'demo', 'package.json'), '{}')
  await updateMeta('demo', { model: 'x/text-only', lookModel: 'z-ai/glm-5.3-flash', params: { effort: 'high' }, gate: 'plan', design: true, budget: 5, usd: 1, turns: 1 })
  // A settings save and a turn's closing write, racing — the turn's is the one that used to
  // write every field back from readMeta, so settings it did not know about were erased.
  await Promise.all([updateMeta('demo', { params: { effort: 'low', temperature: 0.5 } }), updateMeta('demo', { usd: 2, turns: 2 })])
  const meta = await readMeta('demo')
  check(meta.usd === 2 && meta.turns === 2, 'the spend tally survives a concurrent settings save')
  check(meta.params?.effort === 'low' && meta.params.temperature === 0.5, 'the settings survive the turn’s closing write')
  check(meta.lookModel === 'z-ai/glm-5.3-flash', 'the screenshot model survives too')
  check(meta.gate === 'plan' && meta.design === true && meta.budget === 5, 'and the harness options: readMeta names them, so the write keeps them')

  // What PATCH does with `params` (routes.ts): a patch, applied inside the queue to whatever the
  // write before it left. Whole sets built from the client's last fetch reverted each other.
  const patch = (p: unknown) => updateMeta('demo', (m) => ({ params: paramsPatch(p)(m.params) }))
  await Promise.all([patch({ temperature: 0.3 }), patch({ top_p: 0.9 })])
  let merged = await readMeta('demo')
  check(
    merged.params?.temperature === 0.3 && merged.params.top_p === 0.9 && merged.params.effort === 'low',
    `two saves of different keys at once both land, the rest kept: ${JSON.stringify(merged.params)}`,
  )
  await patch({ temperature: null })
  merged = await readMeta('demo')
  check(merged.params?.temperature === undefined && merged.params?.top_p === 0.9, 'null clears that key only')
  // A switch sent while Thinking saves are in flight, as the panel sends them: in order. It
  // decides on the effort the last of them stored, not on one the panel had on screen.
  await Promise.all([patch({ effort: 'none' }), patch({ effort: 'max' }), patch(unfit(glm))])
  check((await readMeta('demo')).params?.effort === 'max', 'a switch keeps the effort the save before it stored')
  await Promise.all([patch({ effort: 'max' }), patch({ effort: 'none' }), patch(unfit(glm))])
  check((await readMeta('demo')).params?.effort === undefined, 'and clears it when that one is off, which GLM refuses')
  await patch(null)
  check((await readMeta('demo')).params === undefined, 'params: null clears them all')

  // Stored params that are not an object are logged whole. Taken key by key, 5 went with no
  // line and 'high' with a line a character.
  const logged: string[] = []
  const stderr = console.error
  console.error = (line: string) => void logged.push(line)
  for (const params of [5, 'high']) {
    await Bun.write(join(TMP, 'demo', '.apps-builder', 'project.json'), JSON.stringify({ params, usd: 2, turns: 2 }))
    await readMeta('demo')
  }
  console.error = stderr
  check(
    logged.join('\n') === '[meta demo] ignoring params 5: params must be an object\n[meta demo] ignoring params "high": params must be an object',
    `stored params that are not an object are logged whole, once: ${JSON.stringify(logged)}`,
  )

  // project.json edited by hand, or saved under a range since tightened (repetition_penalty 0
  // passed before the 0.01 floor): what readMeta returns goes into the body, so it is checked
  // too — key by key, so one bad key does not take the others with it.
  const stale = { temprature: 0.2, repetition_penalty: 0, effort: 'high', top_p: 0.9 }
  await Bun.write(join(TMP, 'demo', '.apps-builder', 'project.json'), JSON.stringify({ params: stale, usd: 2, turns: 2 }))
  const hand = await readMeta('demo') // logs what it ignored
  check(
    JSON.stringify(hand.params) === '{"effort":"high","top_p":0.9}' && hand.usd === 2,
    `a stored key that fails cleanParams is ignored; the other keys and the rest still read: ${JSON.stringify(hand.params)}`,
  )

  // Readers run outside the queue. A write in place let a listing read half a project.json —
  // a JSON parse error out of a PATCH that had saved. The tally's function form is the turn's
  // closing write, so no increment may go missing either.
  let torn = 0
  const list = () => listProjects().then(
    () => {},
    () => void torn++,
  )
  const long = { effort: 'minimal' as const, temperature: 0.3, top_p: 0.9, min_p: 0.05, top_a: 0.1, seed: 12345 }
  for (let i = 0; i < 300; i++) {
    await Promise.all([
      updateMeta('demo', { params: i % 2 ? long : { effort: 'high' } }).then(list),
      updateMeta('demo', { params: i % 2 ? { effort: 'high' } : long }).then(list),
      updateMeta('demo', (m) => ({ usd: m.usd + 1, turns: m.turns + 1 })),
    ])
  }
  check(torn === 0, `300 rounds of saves racing listings: ${torn} torn reads`)
  check((await readMeta('demo')).turns === 302, 'no tally increment lost among them')

  // A rename landing between writeMeta's requireProject and its write, at a spread of offsets.
  // Bun.write's parent-creating default answered 200 into a recreated old directory: a ghost
  // listed as a project that nothing in the UI can delete.
  let ghosts = 0
  for (let i = 0; i < 40; i++) {
    await rm(join(TMP, 'alpha'), { recursive: true, force: true })
    await rm(join(TMP, 'beta'), { recursive: true, force: true })
    await mkdir(join(TMP, 'alpha'))
    await Bun.write(join(TMP, 'alpha', 'package.json'), '{}')
    const moved = async () => {
      for (let t = 0; t < i % 8; t++) await null
      await rename(join(TMP, 'alpha'), join(TMP, 'beta'))
    }
    await Promise.all([updateMeta('alpha', { model: 'x/y' }).catch(() => {}), moved()])
    if ((await readdir(TMP)).includes('alpha')) ghosts++
  }
  check(ghosts === 0, `a settings write racing a rename 40 times: ${ghosts} ghost directories`)

  // writeJson's temporary, as a checkpoint between its write and its rename finds it. Listed,
  // it went to `git add` gone by then — exit 128, the turn's commit lost — or into the commit.
  const repo = join(TMP, 'gitdemo')
  await mkdir(join(repo, '.apps-builder'), { recursive: true })
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
  await Bun.write(join(repo, 'package.json'), '{}')
  await Bun.write(join(repo, '.apps-builder', 'project.json.tmp'), '{}')
  const turn = await checkpoint(repo, 'turn 1', (p) => p === 'package.json' || p.startsWith('.apps-builder/'))
  await Bun.write(join(repo, 'b.ts'), '')
  const edit = await checkpoint(repo, 'edit: b.ts')
  const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: repo }).stdout.toString().trim().split('\n')
  check(!!turn && !!edit && tracked.join() === 'b.ts,package.json', `checkpoints leave writeJson's temporary out: ${tracked}`)
})
