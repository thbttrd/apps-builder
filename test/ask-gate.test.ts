/**
 * The turn's two pauses for the person: ask_user, which ends the turn on a question the next
 * message answers, and the plan gate, which holds the build until the person says go. Then the
 * effort each phase goes out at.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'bun:test'
import { type TextStreamPart, type ToolSet, stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import { type Question, answer, answerOf, pending, withoutPlans } from '../shared/ask'
import { askedPlan, effortStep, gateOf, heldAgain, heldStopNote } from '../server/plan'
import { tools } from '../server/tools'
import { type StoredMessage, toTurns } from '../src/turns'
import { GLM_CHAT, TMP, check, noteOf, planOf, relayed, replyOf, textOf, toolsOf, usage } from './fixtures'

test('ask_user: the turn ends on it, and the next message is its answer', async () => {
  // The real streamText over a mock, with the question asked in the same message as a tool
  // that runs. `ai` 7 runs that one, cannot run the question, and stops: a second model call
  // would be the loop carrying on past it, and chat.json then ends on the open call.
  const Q: Question[] = [
    { question: 'Who is it for?', header: 'Audience', options: [{ label: 'Me' }, { label: 'A team' }], multiSelect: false },
  ]
  let calls = 0
  const asking = streamText({
    model: new MockLanguageModelV3({
      doStream: async () => {
        calls++
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            // GLM's blank text part before its calls, which drew an empty paragraph.
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: ' ' },
            { type: 'text-end', id: 't' },
            { type: 'tool-input-start', id: 'w', toolName: 'noop' },
            { type: 'tool-call', toolCallId: 'w', toolName: 'noop', input: '{}' },
            { type: 'tool-input-start', id: 'q', toolName: 'ask_user' },
            { type: 'tool-call', toolCallId: 'q', toolName: 'ask_user', input: JSON.stringify({ questions: Q }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        }
      },
    }),
    prompt: 'a habit tracker',
    tools: {
      noop: tool({ inputSchema: z.object({}), execute: async () => 'ok' }),
      ask_user: tool({ inputSchema: z.object({ questions: z.array(z.any()) }) }),
    },
    stopWhen: stepCountIs(5),
  })
  const askedLive = await relayed(asking.fullStream)
  const past: StoredMessage[] = [
    { role: 'user', content: 'a habit tracker' },
    ...JSON.parse(JSON.stringify((await asking.steps).flatMap((s) => s.response.messages))),
  ]
  check(calls === 1, `ask: the loop stops on the question — one model call (${calls})`)
  const liveAsks = askedLive.events.filter((e) => e.type === 'ask')
  check(
    liveAsks.length === 1 && JSON.stringify(liveAsks[0]?.type === 'ask' && liveAsks[0].questions) === JSON.stringify(Q) &&
      !askedLive.events.some((e) => e.type === 'tool' && e.name === 'ask_user'),
    `ask: live, the question is one \`ask\` event and never a row -> ${askedLive.order}`,
  )
  const openTurns = toTurns(past)
  check(
    JSON.stringify(replyOf(openTurns.at(-1))?.ask) === JSON.stringify(Q) &&
      JSON.stringify(toolsOf(openTurns.at(-1)).map((t) => t.name)) === '["noop"]' && textOf(openTurns.at(-1)) === '',
    `ask: reloaded, the last turn holds the card, only the other tool's row, and no blank text -> ${JSON.stringify(openTurns.at(-1))}`,
  )
  // A code-only restore lands its ⟲ note after the open question; the answer still goes
  // straight after the call, ahead of the note and of the other tool's result.
  const restored = [...past, { role: 'user', content: '⟲ The project files were restored.' }]
  const spliced = answer(restored, answerOf(Q, [['A team']])) ?? []
  const result = spliced[pending(restored)?.at ?? -1] as { role?: string; content?: { toolCallId?: string; output?: { value?: string } }[] }
  check(
    result?.role === 'tool' && result.content?.[0]?.toolCallId === 'q' &&
      result.content[0].output?.value === 'Who is it for? → A team' && spliced.length === restored.length + 1 &&
      spliced.at(-1) === restored.at(-1),
    `ask: the answer is the call's result, right after the call and before the ⟲ note -> ${JSON.stringify(spliced.map((m) => m.role))}`,
  )
  const answeredTurns = toTurns(spliced)
  check(
    pending(spliced) === null && !answeredTurns.some((t) => replyOf(t)?.ask) &&
      JSON.stringify(answeredTurns.slice(-2).map((t) => [t.role, textOf(t), noteOf(t)])) ===
        '[["user","Who is it for? → A team",false],["user","⟲ The project files were restored.",true]]',
    `ask: answered, the card is gone and the answer reloads as the person's turn -> ${JSON.stringify(answeredTurns.slice(-2))}`,
  )
  // The real ask_user, asked wrong and then right: GLM-shaped options, plain strings and no
  // header, fail its schema, and the SDK stores the error as that call's result.
  let retries = 0
  const reasking = streamText({
    model: new MockLanguageModelV3({
      doStream: async () => {
        const input = retries++ ? { questions: Q } : { questions: [{ question: 'Who?', options: ['Me', 'A team'] }] }
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `q${retries}`, toolName: 'ask_user', input: JSON.stringify(input) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
          ]),
        }
      },
    }),
    prompt: 'a habit tracker',
    tools: { ask_user: tools('ask-check', TMP).ask_user },
    stopWhen: stepCountIs(5),
  })
  await reasking.consumeStream()
  const reasked = toTurns([
    { role: 'user', content: 'a habit tracker' },
    ...JSON.parse(JSON.stringify((await reasking.steps).flatMap((s) => s.response.messages))),
  ])
  check(
    retries === 2 && JSON.stringify(reasked.map((t) => [t.role, !!replyOf(t)?.ask])) === '[["user",false],["assistant",true]]',
    `ask: a call that failed the schema reloads as nothing — not as the person's message -> ${JSON.stringify(reasked.map((t) => [t.role, textOf(t).slice(0, 40)]))}`,
  )
  // While the plan is held, code puts it in the question's call: live on the `ask` event, and
  // on a reload the turn keeps it after the answer, though its card is gone. Not held, none.
  const P = { steps: [{ title: 'Board', contract: 'a 3x3 board', status: 'pending' as const }] }
  const planAsk = (held: boolean) =>
    streamText({
      model: new MockLanguageModelV3({
        doStream: [
          {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'p', toolName: 'ask_user', input: JSON.stringify({ questions: Q }) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
            ] satisfies LanguageModelV3StreamPart[]),
          },
        ],
      }),
      prompt: 'a game',
      tools: { ask_user: tools('ask-check', TMP, { gate: 'plan', plan: { was: P, held } }).ask_user },
      stopWhen: stepCountIs(3),
    })
  const askHistory = async (run: ReturnType<typeof planAsk>): Promise<StoredMessage[]> => [
    { role: 'user', content: 'a game' },
    ...JSON.parse(JSON.stringify((await run.steps).flatMap((s) => s.response.messages))),
  ]
  const heldAsk = planAsk(true)
  const heldEvent = (await relayed(heldAsk.fullStream)).events.find((e) => e.type === 'ask')
  const heldAnswered = toTurns(answer(await askHistory(heldAsk), answerOf(Q, [['Me']])) ?? [])
  const freeAsk = planAsk(false)
  await freeAsk.consumeStream()
  const freeTurns = toTurns(await askHistory(freeAsk))
  check(
    JSON.stringify(heldEvent?.type === 'ask' && heldEvent.plan) === JSON.stringify(P) &&
      JSON.stringify(heldAnswered.map((t) => [t.role, !!replyOf(t)?.ask, replyOf(t)?.plan?.steps[0]?.title ?? null])) ===
        '[["user",false,null],["assistant",false,"Board"],["user",false,null]]' &&
      freeTurns.every((t) => !replyOf(t)?.plan) && !!replyOf(freeTurns.at(-1))?.ask,
    `ask: a held plan rides on the question, live and reloaded, and stays after the answer -> ${JSON.stringify(heldAnswered.map((t) => [t.role, replyOf(t)?.plan?.steps.length]))}`,
  )
  // GLM opens a step with a lone ' ': live, it drew as blank lines above the next step's words.
  const spaced = await relayed(
    (async function* () {
      yield* [
        { type: 'text-start', id: 'a' },
        { type: 'text-delta', id: 'a', text: ' ' },
        { type: 'text-end', id: 'a' },
        { type: 'text-start', id: 'b' },
        { type: 'text-delta', id: 'b', text: 'Done.' },
        { type: 'text-delta', id: 'b', text: ' ' },
        { type: 'text-delta', id: 'b', text: 'Next.' },
        { type: 'text-end', id: 'b' },
        { type: 'text-start', id: 'c' },
        { type: 'text-delta', id: 'c', text: '\n' },
        { type: 'text-delta', id: 'c', text: ' Last.' },
        { type: 'text-end', id: 'c' },
      ] as TextStreamPart<ToolSet>[]
    })(),
  )
  const spacedReload = textOf(toTurns([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: ' ' }, { type: 'text', text: 'Done. Next.' }, { type: 'text', text: '\n Last.' }] },
  ]).at(-1))
  check(
    spaced.text === 'Done. Next.\n\nLast.' && spacedReload === spaced.text,
    `ask: live, a step that says only ' ' leaves no gap, a block's leading break goes, a space inside stays — as on a reload -> ${JSON.stringify([spaced.text, spacedReload])}`,
  )
  check(
    answer(GLM_CHAT, 'why?') === null &&
      answerOf([...Q, { ...Q[0]!, question: 'Which?', multiSelect: true }], [[], ['a', 'b']]) ===
        'Who is it for? → no preference\nWhich? → a, b',
    'ask: with no question open a message is just a message; an unpicked question goes as "no preference"',
  )

  // The plan a question carries: nothing is in progress while it is open, and only the step
  // gate frames one step, the one its question asks about (feedback-1, 2026-10-06).
  const eagerPlan = { steps: [{ title: 'A', contract: 'a', status: 'doing' as const }, { title: 'B', contract: 'b', status: 'pending' as const }] }
  check(
    JSON.stringify(askedPlan('plan', eagerPlan)) === JSON.stringify({ steps: eagerPlan.steps.map((s) => ({ ...s, status: 'pending' })) }) &&
      askedPlan('step', eagerPlan).next === 0 &&
      askedPlan('step', { steps: [{ ...eagerPlan.steps[0]!, status: 'done' }, eagerPlan.steps[1]!] }).next === 1 &&
      askedPlan('step', { steps: eagerPlan.steps.map((s) => ({ ...s, status: 'done' as const })) }).next === undefined,
    `asked: a plan under a question has nothing doing; 'plan' frames no step, 'step' the one asked about, a finished plan none -> ${JSON.stringify(askedPlan('plan', eagerPlan))}`,
  )

  check(
    askedPlan('step', { steps: [{ ...eagerPlan.steps[0]!, status: 'done' }, eagerPlan.steps[1]!, { title: 'C', contract: 'c', status: 'doing' }] }).next === 2,
    "asked: under 'step' it frames the step gateOf names, the one doing, not the first not done",
  )
  const withPlan = [
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'u', toolName: 'update_plan', input: eagerPlan },
        { type: 'tool-call', toolCallId: 'q', toolName: 'ask_user', input: { questions: Q, plan: askedPlan('plan', eagerPlan) } },
      ],
    },
  ]
  const stripped = withoutPlans(withPlan)
  check(
    JSON.stringify(stripped[1]) ===
      JSON.stringify({ ...withPlan[1], content: [withPlan[1]!.content[0], { ...(withPlan[1]!.content as object[])[1], input: { questions: Q } }] }) &&
      stripped[0] === withPlan[0] && JSON.stringify((withPlan[1]!.content as { input: { plan?: unknown } }[])[1]!.input.plan) !== undefined,
    'withoutPlans: the model is sent its questions without the plan code drew, and update_plan as it was',
  )
})

test("the gate: what update_plan tells the model to do next", async () => {
  const fresh = gateOf('step', null, planOf('pending', 'pending'))
  check(
    fresh.hold && fresh.say.includes('build step 1, "S1"') && fresh.say.includes('do not repeat it') && !fresh.say.includes('does 1'),
    `gate step: a new plan holds, on the first step, and leaves the plan to the card -> ${fresh.say}`,
  )
  const stepped = gateOf('step', planOf('doing', 'pending'), planOf('done', 'pending'))
  check(stepped.hold && stepped.say.includes('build step 2, "S2"'), `gate step: a step newly done holds, on the next one -> ${stepped.say}`)
  const started = gateOf('step', planOf('done', 'pending'), planOf('done', 'doing'))
  check(
    !started.hold && started.say.includes('Build step 2, "S2", and nothing past it') && !started.say.includes('step 3'),
    `gate step: starting a step names it, and the last one has no "before step N" -> ${started.say}`,
  )
  const planned = gateOf('plan', null, planOf('pending', 'pending'))
  check(
    planned.hold && planned.say.includes('"Build it"') && planned.say.includes('do not repeat it') && !planned.say.includes('does 1'),
    `gate plan: a new plan is put to the person, in one sentence under the card -> ${planned.say}`,
  )
  const onward = gateOf('plan', planOf('doing', 'pending', 'pending'), planOf('done', 'pending', 'pending'))
  check(
    !onward.hold && onward.say.includes('Build step 2, "S2"') && onward.say.includes('before you write any file for step 3'),
    `gate plan: a step done does not hold, and says to report the next before the one after -> ${onward.say}`,
  )
  const wrapped = gateOf('step', planOf('done', 'doing'), planOf('done', 'done'))
  check(!wrapped.hold && wrapped.say.includes('every step is done'), `gate: the last step done wraps up, in either -> ${wrapped.say}`)
  // Finished past a step no one said go to (open work, 2026-09-30).
  const together = gateOf('step', planOf('done', 'doing', 'pending'), planOf('done', 'done', 'done'))
  check(
    together.hold && together.say.includes('"Looks right"') && together.say.includes('check_app'),
    `gate step: two steps done in one update hold, last ones too, and are checked first -> ${together.say}`,
  )
  check(gateOf('step', null, planOf('done', 'done')).hold, 'gate step: a first plan sent finished holds')
  check(!gateOf('plan', planOf('done', 'doing', 'pending'), planOf('done', 'done', 'done')).hold, 'gate plan: steps done together do not hold')
  check(gateOf('plan', planOf('done', 'done'), planOf('done', 'done', 'done')).hold, 'gate plan: a step appended and finished in one update holds')
  const renamedDone = { steps: [planOf('done').steps[0]!, { title: 'S2 in blue', contract: 'does 2', status: 'done' as const }] }
  check(!gateOf('step', planOf('done', 'done'), renamedDone).hold, 'gate step: a finished plan with a step renamed wraps up')
  // New by its titles and count as well as by its statuses (review of #19, 2026-09-26).
  const eager = gateOf('step', null, planOf('doing', 'pending'))
  check(eager.hold && eager.say.includes('build step 1, "S1"'), `gate step: a first plan sent with step 1 doing still holds -> ${eager.say}`)
  const appended = { steps: [...planOf('done', 'done').steps, { title: 'Dark mode', contract: 'adds it', status: 'pending' as const }] }
  check(gateOf('plan', planOf('done', 'done'), appended).hold, 'gate plan: a step appended to a finished plan is put to the person')
  const renamedStep = { steps: [planOf('done').steps[0]!, { title: 'S2 in blue', contract: 'does 2', status: 'pending' as const }] }
  const retitled = gateOf('step', planOf('done', 'pending'), renamedStep)
  check(retitled.hold && retitled.say.includes('build step 2, "S2 in blue"'), `gate step: a renamed step is put to the person, by its new title -> ${retitled.say}`)
  const reworded = { steps: [planOf('done').steps[0]!, { title: 'S2', contract: 'does 2, better', status: 'doing' as const }] }
  check(!gateOf('step', planOf('done', 'pending'), reworded).hold, 'gate step: a contract reworded under the same title does not hold')

  // The hold, through the SDK: GLM sent the update_plan that finished a step in one message
  // with the next step's writes. The tools of a message start in their order, so the hold is
  // set before the write runs — held on the real tools() under the real streamText.
  const holdDir = join(TMP, 'hold-check')
  await Bun.write(join(holdDir, '.apps-builder', 'plan.json'), JSON.stringify(planOf('doing', 'pending')))
  await Bun.write(join(holdDir, 'src', 'Kept.tsx'), 'kept')
  const gateHold = { was: planOf('doing', 'pending'), held: false }
  const heldRun = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'p', toolName: 'update_plan', input: JSON.stringify(planOf('done', 'doing')) },
            { type: 'tool-call', toolCallId: 'w', toolName: 'write_file', input: JSON.stringify({ path: 'src/Late.tsx', content: 'x' }) },
            { type: 'tool-call', toolCallId: 'e', toolName: 'edit_file', input: JSON.stringify({ path: 'src/Kept.tsx', old_string: 'kept', new_string: 'late' }) },
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
    prompt: 'go on',
    tools: tools('hold-check', holdDir, { plan: gateHold }),
    stopWhen: stepCountIs(3),
  })
  await heldRun.consumeStream()
  const writeResult = (await heldRun.steps)[0]?.toolResults.find((r) => r.toolName === 'write_file')?.output
  check(
    gateHold.held && !(await Bun.file(join(holdDir, 'src', 'Late.tsx')).exists()) && String(writeResult).startsWith('Not written'),
    `hold: a write in the message that finished a step is refused, not written -> ${JSON.stringify(writeResult)}`,
  )
  const editHeld = (await heldRun.steps)[0]?.toolResults.find((r) => r.toolName === 'edit_file')?.output
  check(
    String(editHeld).startsWith('Not written') && (await Bun.file(join(holdDir, 'src', 'Kept.tsx')).text()) === 'kept',
    `hold: so is an edit -> ${JSON.stringify(editHeld)}`,
  )
  // The guard: the model read HELD and wrote again, so the turn stops on the second refused
  // step instead of writing on, refused each time, to the end of its budget.
  let heldN = 0
  const writeOn = streamText({
    model: new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: `h${++heldN}`, toolName: 'write_file', input: JSON.stringify({ path: 'src/Late.tsx', content: 'x' }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] satisfies LanguageModelV3StreamPart[]),
      }),
    }),
    prompt: 'go on',
    tools: tools('hold-check', holdDir, { plan: { was: planOf('done', 'doing'), held: true } }),
    stopWhen: [stepCountIs(6), heldAgain],
  })
  await writeOn.consumeStream()
  const writeOnSteps = await writeOn.steps
  const heldNote = heldStopNote(writeOnSteps)
  check(
    writeOnSteps.length === 2 && heldNote?.startsWith('⚠ The plan is waiting for your go') === true,
    `hold: a second refused step ends the turn, and says why -> ${writeOnSteps.length} steps, ${heldNote?.slice(0, 40)}`,
  )
  check(
    heldStopNote(writeOnSteps.slice(0, 1)) === null &&
      heldStopNote([writeOnSteps[0]!, { toolResults: writeOnSteps[1]!.toolResults, toolCalls: [{ toolName: 'ask_user' }] }]) === null,
    'hold: one refused step is not the guard, and no note when the last step asked after all',
  )
  // Review of #44. A finish split over two update_plans in one message: the second is judged
  // against the plan before the hold, so it is held too, not told to wrap up. And a finish's
  // hold lets its own message's writes land — they are the steps it marks done — but not the
  // next message's.
  const step = (...parts: LanguageModelV3StreamPart[]) => ({
    stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      ...parts,
      { type: 'finish', finishReason: { unified: parts.length ? 'tool-calls' : 'stop', raw: undefined }, usage },
    ] satisfies LanguageModelV3StreamPart[]),
  })
  const call = (id: string, toolName: string, input: object): LanguageModelV3StreamPart => ({ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) })
  const splitHold = { was: planOf('done', 'doing', 'pending'), held: false }
  const split = streamText({
    model: new MockLanguageModelV3({
      doStream: [step(call('s1', 'update_plan', planOf('done', 'done', 'pending')), call('s2', 'update_plan', planOf('done', 'done', 'done'))), step()],
    }),
    prompt: 'go on',
    tools: tools('hold-check', holdDir, { plan: splitHold }),
    stopWhen: stepCountIs(3),
  })
  await split.consumeStream()
  const splitSaid = String((await split.steps)[0]?.toolResults.find((r) => r.toolCallId === 's2')?.output)
  check(splitHold.held && splitSaid.includes('"Looks right"'), `hold: a finish split over two update_plans holds on the second too -> ${splitSaid}`)
  const finishHold = { was: planOf('doing', 'pending'), held: false }
  const finished = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        step(call('f', 'update_plan', planOf('done', 'done')), call('f1', 'write_file', { path: 'src/Last.tsx', content: 'x' })),
        step(call('f2', 'write_file', { path: 'src/After.tsx', content: 'x' })),
        step(),
      ],
    }),
    prompt: 'go on',
    tools: tools('hold-check', holdDir, { plan: finishHold }),
    stopWhen: stepCountIs(4),
  })
  await finished.consumeStream()
  const afterSaid = (await finished.steps)[1]?.toolResults.find((r) => r.toolCallId === 'f2')?.output
  check(
    finishHold.held &&
      (await Bun.file(join(holdDir, 'src', 'Last.tsx')).exists()) &&
      !(await Bun.file(join(holdDir, 'src', 'After.tsx')).exists()) &&
      String(afterSaid).startsWith('Not written'),
    `hold: a finish's own writes land, the next message's are refused -> ${JSON.stringify(afterSaid)}`,
  )

  // Two update_plans in one message run together; the file must end on the later plan, the
  // one the gate judged last — and neither call may come back as an error.
  const twice = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'p1', toolName: 'update_plan', input: JSON.stringify(planOf('done', 'pending')) },
            { type: 'tool-call', toolCallId: 'p2', toolName: 'update_plan', input: JSON.stringify(planOf('done', 'doing')) },
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
    prompt: 'go on',
    tools: tools('hold-check', holdDir, { gate: 'plan', plan: { was: planOf('done', 'pending'), held: false } }),
    stopWhen: stepCountIs(3),
  })
  await twice.consumeStream()
  const twiceErrors = (await twice.steps)[0]?.content.filter((p) => p.type === 'tool-error').length
  const lastPlan = (await Bun.file(join(holdDir, '.apps-builder', 'plan.json')).json()) as { steps: { status: string }[] }
  check(
    twiceErrors === 0 && lastPlan.steps[1]?.status === 'doing',
    `plan: two update_plans in one message both save, the later last -> errors ${twiceErrors}, step 2 ${lastPlan.steps[1]?.status}`,
  )
  await rm(holdDir, { recursive: true, force: true })
})

test("effort by phase: plan at the project's, build at less", async () => {
  // Two mocks stand for the two efforts; which one served each request is which effort it
  // went out at. No plan: the project's. update_plan saves one with a step to do: the build
  // effort from the next request on. The last step marked done: still the build effort, to
  // the turn's end — the closing summary rides the cache.
  const phaseDir = join(TMP, 'phase-check')
  const steps2 = (a: string, b: string) => ({
    steps: [
      { title: 'S1', contract: 'does 1', status: a },
      { title: 'S2', contract: 'does 2', status: b },
    ],
  })
  const planStep = (id: string, input: object) =>
    convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: id, toolName: 'update_plan', input: JSON.stringify(input) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
    ] satisfies LanguageModelV3StreamPart[])
  const endOf = () =>
    convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ] satisfies LanguageModelV3StreamPart[])
  const planner = new MockLanguageModelV3({ doStream: [{ stream: planStep('p1', steps2('doing', 'pending')) }] })
  const builder = new MockLanguageModelV3({
    doStream: [{ stream: planStep('p2', steps2('done', 'doing')) }, { stream: planStep('p3', steps2('done', 'done')) }, { stream: endOf() }],
  })
  const phaseHold = { was: null, held: false }
  const madeAt: string[] = []
  const phased = streamText({
    model: planner,
    prompt: 'a counter',
    tools: tools('phase-check', phaseDir, { gate: 'plan', plan: phaseHold }),
    prepareStep: effortStep(phaseHold, 'medium', (e) => (madeAt.push(e), builder)),
    stopWhen: stepCountIs(6),
  })
  await phased.consumeStream()
  check(
    planner.doStreamCalls.length === 1 && builder.doStreamCalls.length === 3,
    `phase: planned at the project's effort, built and summed up at medium -> planned ${planner.doStreamCalls.length}, built ${builder.doStreamCalls.length}`,
  )
  check(madeAt.join() === 'medium', `phase: the build model is made once, at medium -> ${madeAt.join()}`)
  const none = new MockLanguageModelV3({ doStream: [{ stream: planStep('q1', steps2('doing', 'pending')) }, { stream: endOf() }] })
  // One hold for both, as in chat(): update_plan moves it, so a build effort, were there one,
  // would switch after q1.
  const noHold = { was: null, held: false }
  const noBuild = streamText({
    model: none,
    prompt: 'a counter',
    tools: tools('phase-check', phaseDir, { gate: 'plan', plan: noHold }),
    prepareStep: effortStep(noHold, undefined, () => builder),
    stopWhen: stepCountIs(4),
  })
  await noBuild.consumeStream()
  check(none.doStreamCalls.length === 2, `phase: with no build effort (medium or less, off, no catalog) every request is as planned -> ${none.doStreamCalls.length}`)
  // The way back, now at the next turn's start (review of #45): a turn that opens on a finished
  // plan goes out at the project's effort, and does not make the build model.
  const reopened: string[] = []
  const back = effortStep({ was: planOf('done', 'done'), held: false }, 'medium', (e) => (reopened.push(e), builder))()
  check(!('model' in back) && !reopened.length, `phase: a turn that opens on a finished plan goes out at the project's effort -> ${reopened.join() || 'as planned'}`)
  await rm(phaseDir, { recursive: true, force: true })
})

