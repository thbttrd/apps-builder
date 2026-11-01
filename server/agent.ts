import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ModelMessage, type ToolCallPart, generateText, stepCountIs, streamText } from 'ai'
import { COMMIT, checkpoint, isBuilt, noteOutsideEdits } from './git'
import { recordShot } from './previews'
import {
  CHAT,
  HttpError,
  PLAN_FILE,
  SPEC_FILE,
  TURN,
  isMeta,
  readJson,
  readMeta,
  requireProject,
  updateMeta,
  writeJson,
} from './project'
import { type Activity, activityOf } from './activity'
import { answer, isAsk, pending, reasonedFrom, unreasoned, withoutHtml, withoutPlans } from '../shared/ask'
import {
  type Brief,
  type DesignView,
  appName,
  designPhase,
  designSettled,
  designView,
  readDesign,
  gateFor,
  settleTurn,
  takeMessage,
} from './design'
import { type Entry, bySlug } from './design-catalog'
import type { Seer } from './pilot'
import { sentWindow } from '../shared/params'
import { buildEffortOf, catalog } from '../shared/models'
import { DEFAULT_BUDGET, dollars } from '../shared/settings'
import {
  DEFAULT_LOOK_MODEL,
  DEFAULT_MODEL,
  type Costed,
  LOOK,
  configured,
  costOf,
  describer,
  loopModel,
  outputLimit,
} from './model'
import { type Hold, PLAN, type Plan, SAVED_SPEC, type SavedSpec, effortStep, endsOnAsk, heldAgain, heldStopNote } from './plan'
import { SYSTEM } from './prompt'
import { type ChatEvent, isAbort, relay } from './stream'
import { tools } from './tools'
import { type Run, stepLine, trace, usdOf } from './trace'

/**
 * A backstop, not the limit: a message stops on its budget (Spend per message, settings.ts).
 * This one is for a model whose cost reads $0 or comes with no usage, which no budget stops.
 * ponytail: set from 2026-09-30's figures. GLM costs about $0.011–0.0125 a request ($0.26–0.30
 * per 24), so on GLM this binds first, at about $1.20 of the $2 default; Sonnet at xhigh about
 * $0.064 ($0.77 for 12), so $2 buys it about 31, and Opus about 20. fox-glm-flat's plan-gate
 * build needed at least 72 requests, its longest step 47. Raise it once GLM builds end on it.
 */
const MAX_STEPS = 100

type Inflight = { controller: AbortController; done: Promise<void> }

/** slug -> the turn currently running for it. At most one per project. */
const inflight = new Map<string, Inflight>()

export function running(slug: string): boolean {
  return inflight.has(slug)
}

/**
 * The project, claimed for one writer: a turn or a claimed() write. Check and set with no await
 * between them, or two callers both pass the check and the second overwrites the first's claim.
 */
function claim(slug: string, busy: string): { controller: AbortController; release: () => void } {
  if (inflight.has(slug)) throw new HttpError(409, busy)
  const controller = new AbortController()
  let finish!: () => void
  inflight.set(slug, { controller, done: new Promise<void>((r) => (finish = r)) })
  return {
    controller,
    release: () => {
      if (inflight.get(slug)?.controller === controller) inflight.delete(slug)
      finish()
    },
  }
}

/**
 * A write to a project that is not a turn — the design routes, restore, rename, a hand edit —
 * under the turn's own claim: refused while a turn runs, and a turn refused while it runs.
 * Checking running() alone let two approves overlap (an index.html committed half-written) and
 * a turn start mid-approve and commit its files as a hand edit (review, #32).
 */
export async function claimed<T>(slug: string, busy: string, fn: () => Promise<T>): Promise<T> {
  const { release } = claim(slug, busy)
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Stop the turn for a slug and wait for it to actually stop.
 *
 * Waiting is the point, not politeness: the loop may be inside a write_file, and
 * Bun.write creates parent directories — so deleting the project first would let a
 * straggling write recreate it. Resolves immediately when nothing is running.
 */
export async function abortTurn(slug: string): Promise<boolean> {
  const live = inflight.get(slug)
  if (!live) return false
  const t0 = Date.now()
  live.controller.abort()
  const ended = await Promise.race([live.done.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!ended) {
    // Belt and braces: the loop's own finally should always clear this. If it somehow
    // did not, refusing to drop the entry would wedge the project as "running" forever.
    console.error(`[abort ${slug}] loop did not end within 10s after ${Date.now() - t0}ms; dropping it`)
    if (inflight.get(slug) === live) inflight.delete(slug)
  }
  return true
}

/** A promise that must not reject, whatever the stream did. */
function settled<T>(p: PromiseLike<T>): Promise<T | undefined> {
  return Promise.resolve(p).then(
    (v) => v,
    () => undefined,
  )
}

export async function history(slug: string): Promise<ModelMessage[]> {
  return readJson<ModelMessage[]>(join(await requireProject(slug), CHAT), [])
}

/** The design brief as the Artefacts pane draws it: the picks, and the catalog design picked. */
export type DesignBrief = { brief: Brief; inspiration: Entry | null }

/**
 * What the Artefacts pane shows (GET /artefacts): each null until it is first saved. `examples`
 * is the design examples and the phase they are in, which the chat's picker reads too.
 */
export type ArtefactsView = { spec: SavedSpec | null; plan: Plan | null; design: DesignBrief | null; examples: DesignView | null }

/**
 * spec.json or plan.json as its schema has it. Never throws: unreadable or of another shape (a hand edit, an
 * older release's), it is none, as readDesign's design.json is: the pane draws without it, a turn's gate
 * reads no plan, and the next save_spec or update_plan overwrites it.
 */
const readSaved = <T>(dir: string, file: string, schema: { safeParse: (v: unknown) => { data?: T } }) =>
  readJson<unknown>(join(dir, file), null).then((v) => (v === null ? null : (schema.safeParse(v).data ?? null)), () => null)

export async function artefacts(slug: string): Promise<ArtefactsView> {
  const dir = await requireProject(slug)
  const [spec, plan, design, meta, built] = await Promise.all([
    readSaved<SavedSpec>(dir, SPEC_FILE, SAVED_SPEC),
    readSaved<Plan>(dir, PLAN_FILE, PLAN),
    readDesign(dir),
    readMeta(slug),
    isBuilt(dir),
  ])
  const brief = design?.brief
  return {
    spec,
    plan,
    design: brief ? { brief, inspiration: bySlug(brief.inspiration) ?? null } : null,
    examples: design?.examples ? designView(designPhase(meta.design === true, built, design), design) : null,
  }
}

/** `ask`: the question a card answers (its call's id). A typed message names none, and answers whatever is open. */
export async function chat(slug: string, message: string, ask?: string): Promise<ReadableStream<Uint8Array>> {
  if (!configured()) throw new HttpError(503, 'OPENROUTER_API_KEY is not set')
  const dir = await requireProject(slug)
  const meta = await readMeta(slug)
  const model = meta.model ?? DEFAULT_MODEL
  // Set for a model that cannot see images: the panel proposes one when such a model is
  // picked, and clears it when the catalog says the next one can see for itself. A switch
  // to a model the catalog does not list keeps it, so it can outlast the need. A project on
  // the default has none set, and looks with the house's.
  const looker = meta.lookModel ?? (meta.model ? model : DEFAULT_LOOK_MODEL)
  const budget = meta.budget ?? DEFAULT_BUDGET
  // On every line the turn traces (trace.ts): its own id, and the number its checkpoint gets.
  const run: Run = { run: crypto.randomUUID().slice(0, 8), turn: meta.turns + 1 }
  const began = Date.now()
  // The model's thinking window (see windowOf in shared/models.ts), and what goes out: the
  // project's own, within it (loopModel).
  const full = await outputLimit(model)
  const maxOut = sentWindow(meta.params?.max_tokens, full)
  // What a step of the plan is built at (see effortStep). Without the catalog, nothing changes.
  const entry = await catalog().then((ms) => ms.find((m) => m.id === model), () => undefined)
  const build = buildEffortOf(entry, meta.params?.effort)
  // One turn per project, claimed only now that the reads above are done (claim). A second POST
  // that got here first is refused; one that overwrote the claim left this turn unstoppable,
  // and two loops editing the same files.
  const { controller, release } = claim(slug, `a turn is already running for "${slug}"`)
  // Read only now that the project is this turn's: a rename or a restore can claim, finish and
  // release while the catalog loads above, and a turn that had read first wrote into a ghost of
  // the old slug, or saved the old conversation over the rewound one. A throw between the claim
  // and the stream's own try/finally leaves the project "running" forever, so it gives it back.
  const past = await history(slug).catch((e: unknown) => {
    release()
    throw e
  })
  // A card answers one question. From a second tab, or left on screen after its question was answered, its
  // Go would answer whatever is open now (a later plan step) and spend on it: refused before anything commits.
  if (ask !== undefined && !pending(past)?.ids.includes(ask)) {
    release()
    throw new HttpError(409, 'that question was already answered: the chat now shows where it is')
  }

  // After the inflight claim, not before: it commits, and two turns must not race to.
  // A user turn of its own, like noteRestore()'s, so the person sees what the model was
  // told; it sits after the cached prefix, so the prefix is unchanged. Persisted with the
  // turn — and if the turn dies before its first step, the next one recomputes it.
  const edits = await noteOutsideEdits(dir)

  // The design phase (design.ts), from what is on disk — after the outside edits are committed,
  // since one of those can build the project. Neither read throws.
  const stored = await readDesign(dir)
  const built = await isBuilt(dir)
  const design = gateFor(designPhase(meta.design === true, built, stored), stored, appName(slug))
  const told = await takeMessage(dir, past, message, design)
  // One note: files changed outside the chat, then the design phase's.
  const note = [edits, told].filter(Boolean).join('\n\n') || null

  // A question left open by the last turn: this message is its answer, spliced in after it
  // as the call's result — and then it is not a user turn of its own (see ask.ts).
  const answered = answer(past, message)
  const messages: ModelMessage[] = [
    ...(answered ?? past),
    ...(note ? [{ role: 'user' as const, content: note }] : []),
    ...(answered ? [] : [{ role: 'user' as const, content: message }]),
  ]
  // The design phase moved on disk before the model has run — the brief saved, a once-only note
  // told — so the message and its note are kept now: a turn stopped or failed before its first
  // step writes nothing below, and the note went with it for good (design.ts, `moved`).
  if (design.moved) {
    await writeJson(join(dir, CHAT), messages).catch((e: Error) => console.error(`[agent ${slug}] chat.json:`, e.message))
  }

  // The plan as update_plan last saved it, and whether its gate holds the build for the person.
  // A hold lasts to the end of the turn — the ask_user it calls for ends it — so a second
  // update_plan cannot talk its way past one.
  // Never throws (readSaved): this is after the claim, and a plan.json broken by hand would leave the
  // project "running". gateOf reads `was.steps`.
  const plan: Hold = {
    was: await readSaved<Plan>(dir, PLAN_FILE, PLAN),
    held: false,
  }

  // Every path this turn wrote or deleted, relative to the project. At the end the turn
  // commits only these, so an edit someone else made meanwhile is left for its own commit.
  const own = new Set<string>()
  // The code pane colours what the newest turn changed (TURN), so the last turn's go as this
  // one starts, before any of its writes. Never throws, as above.
  await rm(join(dir, TURN), { force: true }).catch(() => {})

  // check_app's `look`: one picture, one question, one separate call (see pilot.ts) to the
  // describer. It is not a step of this loop, so its cost is not in `steps` — tallied here,
  // added below.
  let lookCost = 0
  // Each request's cost, into the project's tally as it lands and out to the chat, so the
  // counter moves with the turn instead of once at its end, and a turn killed mid-way keeps
  // what it paid for. The figures `spent` sums, so a finished turn's tally ends where it did.
  // Pointed at the stream once it exists, as `tell` is. Never throws: a lost figure is worth
  // less than the step.
  let spend = (_: number) => {}
  const book = async (usd: number) => {
    if (!usd) return
    await updateMeta(slug, (m) => ({ usd: m.usd + usd })).then(
      (m) => spend(m.usd),
      (e: Error) => console.error(`[agent ${slug}] tally:`, e.message),
    )
  }
  const see: Seer = async (jpeg, question) => {
    const t = Date.now()
    const line = { kind: 'look', ...run, model: looker, question }
    try {
      const r = await generateText({
        abortSignal: controller.signal,
        model: describer(looker),
        system: LOOK,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: question },
              { type: 'file', data: jpeg, mediaType: 'image/jpeg' },
            ],
          },
        ],
      })
      const usd = usdOf(r.providerMetadata)
      lookCost += usd
      await book(usd)
      await trace(dir, { ...line, at: new Date().toISOString(), usd, ms: Date.now() - t })
      return r.text
    } catch (e) {
      await trace(dir, { ...line, at: new Date().toISOString(), ms: Date.now() - t, error: (e as Error).message.split('\n')[0] })
      throw e
    }
  }
  // What the message has cost so far: what stops the loop at its budget, and the receipt.
  const spent = (steps: readonly Costed[]) => costOf(steps) + lookCost

  // Made before the stream it reports into, because the tools report through it too and
  // they are handed over here. `tell` is pointed at the stream as soon as it exists.
  let tell = (_: Activity) => {}
  const track = activityOf((a) => tell(a))

  // chat.json as each step ends (keepSteps), so a restart mid-turn loses one request, not the turn.
  const chatPath = join(dir, CHAT)
  const keep = keepSteps(chatPath, messages)
  // The effort each request went out at, for its trace line: the build effort mid-plan.
  const pick = effortStep(plan, build, (effort) => loopModel(model, { ...meta.params, effort }, full))
  let sent: string | undefined
  let stepNo = 0
  // `streamRetries` stays at its default of 0. A retry resets the step the SDK is recording
  // without sending any fullStream part to say so (ai 7.0.107), so the live `thought` trace
  // would keep reasoning that chat.json then drops, and a reload would no longer show what
  // the turn showed.
  const result = streamText({
    abortSignal: controller.signal,
    model: loopModel(model, meta.params ?? {}, full),
    system: SYSTEM,
    // Past turns' reasoning stays in chat.json and out of the request, but for Anthropic's (see ask.ts), and so do
    // the design examples' pages (see design.ts); `messages` itself, reasoning and all, is what
    // the turn persists at its end.
    messages: unreasoned(withoutPlans(withoutHtml(messages)), reasonedFrom(model, past)),
    tools: tools(slug, dir, { gate: meta.gate ?? 'step', plan, see, own, runs: track.runs, design, built }),
    // Code ends the examples' turn once the last one is settled: the picker is the answer. The
    // others end a turn that has spent its budget, or wrote on through a hold (heldAgain).
    stopWhen: [stepCountIs(MAX_STEPS), designSettled(design), heldAgain, ({ steps }) => spent(steps) >= budget],
    prepareStep: () => {
      const next = pick()
      sent = 'model' in next ? build : meta.params?.effort
      return next
    },
    onStepEnd: async (step) => {
      await keep(step)
      // The SDK calls this for exactly the steps it then puts in `result.steps` (ai 7.0.107).
      await book(costOf([step]))
      await trace(dir, stepLine(step, { ...run, step: ++stepNo, model, effort: sent }))
    },
    // The SDK's default handler is console.error(error), so every abort dumped a whole
    // DOMException into the journal. An abort is how a turn is meant to end here.
    onError: ({ error }) => {
      if (!isAbort(error)) console.error(`[agent ${slug}]`, error)
    },
  })

  return new ReadableStream({
    async start(streamOut) {
      // Nothing that writes to the stream may throw. The reader can vanish at any moment
      // — a reload, a closed tab — and an enqueue that throws out of the loop would skip
      // the cleanup below, leaving the turn in `inflight` forever: permanently "running",
      // unstoppable, and 409ing every new turn. The loop keeps going once the reader is
      // gone, because it is still writing the files that were asked for.
      let writable = true
      const push = (chunk: string) => {
        if (!writable) return
        try {
          streamOut.enqueue(encoder.encode(chunk))
        } catch {
          writable = false
        }
      }
      const send = (e: ChatEvent) => push(`data: ${JSON.stringify(e)}\n\n`)

      // An SSE comment: every parser ignores it, but it is bytes on the wire. Without it
      // the stream goes silent for as long as the model takes to stream one tool's
      // arguments — a whole source file, token by token, measured at 104s — and
      // Bun.serve's idleTimeout (or any proxy's) closes the socket under us.
      const heartbeat = setInterval(() => push(': ping\n\n'), 15_000)
      if (note) send({ type: 'note', text: note })

      tell = (a) => send({ type: 'activity', ...a })
      spend = (usd) => send({ type: 'spent', usd })

      const subject = message.replace(/\s+/g, ' ').trim().slice(0, 60)
      // The turn's number once the tally has it, and whether its commit is made: what fails after
      // either must not count the turn twice, or commit it again.
      let numbered: number | undefined
      let committed = false
      // One outer try/finally. Whatever happens in between, the turn must leave
      // `inflight` and release whatever is waiting on it.
      try {
        // The check suite runs relay() over the SDK's own stream.
        const { aborted } = await relay(result.fullStream, send, track)

        // Every one of these can reject on an aborted stream; none of them is worth
        // losing the tool calls that already ran.
        const usage = await settled(result.usage)
        const steps = await settled(result.steps)
        // Flattened over every step, NOT `result.response` — same finalStep family as the
        // cost bug below. The SDK builds `response` as `finalStep.then(s => s.response)`
        // and resets each step's recorded content at `start-step`, so persisting it kept
        // only the closing assistant text: every write_file call and its result was
        // dropped from history, and the next turn re-read files this one had just
        // written, burning steps against MAX_STEPS. `steps` is already awaited above.
        const responseMessages = (steps ?? []).flatMap((s) => s.response.messages)
        const cut = cutOffNote(steps ?? [], maxOut, maxOut !== undefined && full !== undefined && maxOut < full)
        // The same sum the budget stopped on (see costOf).
        const cost = spent(steps ?? [])
        // Said under the turn and kept, as the cut is: the note the turn ends on, if any — the
        // first of these that applies — and which one it was, for the trace.
        const notes = { cut, held: heldStopNote(steps ?? []), budget: overBudgetNote(steps ?? [], cost, budget), steps: outOfStepsNote(steps ?? []) }
        const stop = (Object.keys(notes) as (keyof typeof notes)[]).find((k) => notes[k])
        const ending = stop ? notes[stop] : null
        // Its cost is already in the tally: book() put each request's there as it landed.
        const tally = await updateMeta(slug, (m) => ({ turns: m.turns + 1 }))
        numbered = tally.turns
        // Examples left waiting with two passed: the person picks between those (design.ts).
        // Before the checkpoint, which commits design.json with the turn.
        await settleTurn(dir, design)
        // Written once more now the loop has stopped, over keepSteps' last save, with the note
        // the turn ends on. The tool calls and their results go in with the text, which is
        // what makes the next turn able to see its own edits rather than redo them. An aborted
        // turn is persisted too: its tool calls really ran and the files really changed. A
        // turn killed before its first finish-step contributes no steps, so it writes nothing
        // — the one tool call chat.json can end on without a result is an ask_user, which the
        // next turn answers (see ask.ts).
        // .apps-builder exists: the tally's write just made it.
        if (responseMessages.length) {
          await writeJson(chatPath, [
            ...messages,
            ...responseMessages,
            ...(cut ? unrun(responseMessages) : []),
            ...(ending ? [{ role: 'user' as const, content: ending }] : []),
          ])
        }
        // The checkpoint comes after chat.json so the commit carries the conversation that
        // produced it — a reverted project and its history stay in step. An aborted turn is
        // committed too, for the same reason it is persisted: the files really changed.
        //
        // Two commits, not one: the turn's own files and its conversation first, then
        // anything else that changed while it ran — an edit in another editor — as an edit
        // of its own. After the turn's commit on purpose: noteOutsideEdits() reports what
        // came after the last turn, so that is where it has to be to reach the next one.
        // Known limit: a file both the turn and someone else wrote is the turn's; the two
        // cannot be told apart once they are the same bytes.
        const commit = await checkpoint(
          dir,
          `${COMMIT.turn}${tally.turns}${aborted ? ' (stopped)' : ''}: ${subject}`,
          (p) => own.has(p) || isMeta(p),
        )
        committed = true
        await checkpoint(dir, `${COMMIT.edit}outside the chat (during turn ${tally.turns})`)
        await trace(dir, {
          kind: 'turn',
          at: new Date().toISOString(),
          ...run,
          message,
          answer: answered !== null,
          model,
          gate: meta.gate ?? 'step',
          budget,
          params: meta.params,
          design: design.phase,
          steps: steps?.length ?? 0,
          usd: cost,
          stop: stop ?? (aborted ? 'aborted' : endsOnAsk(steps ?? []) ? 'asked' : 'done'),
          // The commit that holds this turn's chat.json and files; null when nothing changed.
          commit,
          ms: Date.now() - began,
        })
        // The preview is up and holding exactly what this turn produced, which is the only
        // moment it can be photographed. Not awaited: the turn is over, and the picture is
        // for the gallery to show later.
        void recordShot(slug)

        if (ending) send({ type: 'note', text: ending, after: true })
        send({
          type: 'done',
          aborted,
          cost,
          usd: tally.usd,
          model,
          usage: {
            input: usage?.inputTokens ?? 0,
            cacheRead: usage?.inputTokenDetails.cacheReadTokens ?? 0,
            cacheWrite: usage?.inputTokenDetails.cacheWriteTokens ?? 0,
            output: usage?.outputTokens ?? 0,
          },
        })
      } catch (e) {
        console.error(`[agent ${slug}]`, e)
        // What a failed turn wrote really changed, as a stopped turn's did, and keepSteps has kept
        // the steps that wrote it: so it is committed as the turn's too. Left on disk, the next
        // turn's outside-edits note handed it back to the model as someone else's, and until then
        // the first build's Home.tsx stood uncommitted under a listing that called it built.
        let commit: string | null = null
        if (own.size && !committed) {
          const n = numbered ?? (await updateMeta(slug, (m) => ({ turns: m.turns + 1 })).then((m) => m.turns, () => undefined))
          if (n !== undefined) commit = await checkpoint(dir, `${COMMIT.turn}${n} (failed): ${subject}`, (p) => own.has(p) || isMeta(p))
        }
        await trace(dir, { kind: 'turn', at: new Date().toISOString(), ...run, message, model, error: (e as Error).message, commit, ms: Date.now() - began })
        if (commit) void recordShot(slug)
        send({ type: 'error', message: (e as Error).message })
      } finally {
        clearInterval(heartbeat)
        release()
        try {
          streamOut.close()
        } catch {
          // already torn down by the reader going away
        }
      }
    },
    cancel() {
      // The reader went away — a reload, a closed tab, a dropped connection. The turn
      // deliberately keeps running: it is producing files the user asked for, and it
      // persists them when it finishes, so a reload must not throw the build away.
      // Stopping is an explicit act — POST /chat/stop — not a side effect of navigating.
      // Bounded by stopWhen — its budget, and stepCountIs(MAX_STEPS) behind it — so an
      // abandoned turn cannot run away.
    },
  })
}

const encoder = new TextEncoder()

/**
 * The note for a turn whose last reply ran into max_tokens, or null. The loop stops there: a
 * reply cut off inside its reasoning has no tool call to go on with, and it used to end as if
 * it had finished — "done", nothing written, nothing said. Under the turn, in chat.json as a
 * note, so the person sees why and the model reads it next turn.
 */
export function cutOffNote(
  steps: readonly { finishReason: string }[],
  limit: number | undefined,
  /** The project's Thinking window is below the model's, so there is room to raise it. */
  lowered = false,
): string | null {
  if (steps.at(-1)?.finishReason !== 'length') return null
  const at = limit ? ` (${limit.toLocaleString('en-US')} tokens)` : ''
  return (
    `⚠ The builder's last reply hit its output limit${at} before it finished, so the turn ` +
    `stopped there. Lower Thinking${lowered ? ' or raise the Thinking window' : ''} in More › ` +
    `Settings, or ask for a smaller piece.`
  )
}

/** Whether a turn was cut short mid-work: its last step went on to call a tool, other than to ask. */
const midWork = (steps: readonly { finishReason: string; toolCalls: readonly { toolName: string }[] }[]) =>
  steps.at(-1)?.finishReason === 'tool-calls' && !endsOnAsk(steps)

/**
 * The note for a turn that ran out of steps, or null. stepCountIs(MAX_STEPS) ends the loop
 * after the last step's tools have run, and the turn used to end there without a word, on
 * whatever that step did — running-fox-glm's last two turns each stopped at 24 on a failed
 * edit, and looked stuck. Not when that step asked a question: the turn ends for that anyway.
 */
export function outOfStepsNote(
  steps: readonly { finishReason: string; toolCalls: readonly { toolName: string }[] }[],
  max = MAX_STEPS,
): string | null {
  if (steps.length < max || !midWork(steps)) return null
  return `⚠ The builder used all ${max} steps one message gets and stopped partway through. Send “continue” and it picks up where it left off.`
}

/**
 * The note for a turn its budget stopped, or null: it spent `spent` of `budget` and its last
 * step went on to call a tool, other than to ask. One that finished on its own, or asked,
 * ended for that, whatever it cost.
 */
export function overBudgetNote(
  steps: readonly { finishReason: string; toolCalls: readonly { toolName: string }[] }[],
  spent: number,
  budget: number,
): string | null {
  if (spent < budget || !midWork(steps)) return null
  return (
    `⚠ The builder spent $${spent.toFixed(2)} of the ${dollars(budget)} one message may spend and stopped partway ` +
    `through. Send “continue” for another ${dollars(budget)}, or raise Spend per message in More › Harness.`
  )
}

/**
 * streamText's onStepEnd: chat.json with every step so far, written after each one — the SDK
 * awaits it before the next request. A dev restart (every server/ edit), a release or a
 * provider error used to lose the whole turn's history, which was written only at its end;
 * now one request. Each step is whole — the calls and their results — so what is on disk is
 * always a conversation the next turn can send, and a reload mid-turn shows the progress.
 * ponytail: a killed turn's commit and turn count are still lost; its files wait for the next
 * turn's outside-edits note.
 */
export function keepSteps(path: string, messages: readonly ModelMessage[]) {
  const kept: ModelMessage[] = []
  return async ({ response }: { response: { messages: readonly ModelMessage[] } }) => {
    kept.push(...response.messages)
    try {
      // The first turn of a project made by name can get here before anything made it.
      await mkdir(dirname(path), { recursive: true })
      await writeJson(path, [...messages, ...kept, ...unrun(kept)])
    } catch (e) {
      // The SDK swallows what this throws; the turn's own save at its end tries again.
      console.error(`[agent] ${path}:`, (e as Error).message)
    }
  }
}

/**
 * Results for the tool calls a cut-off reply made and never ran, as one tool message — or none.
 * The provider hands over a call as soon as its arguments parse, but the SDK runs a step's
 * tools only when it finished on 'stop' or 'tool-calls', never on 'length'; stored without a
 * result, the call failed every later turn with MissingToolResultsError before a request went
 * out, and the chat stayed broken until a restore.
 */
export function unrun(messages: readonly ModelMessage[]): ModelMessage[] {
  const at = messages.findLastIndex((m) => m.role === 'assistant')
  const last = messages[at]
  if (last?.role !== 'assistant' || typeof last.content === 'string') return []
  // A call the SDK found invalid has its error as a result already, in a tool message after the
  // reply; a question stays open, for the next message to answer (see ask.ts).
  const answered = new Set(
    messages.slice(at + 1).flatMap((m) => (m.role === 'tool' ? m.content.map((p) => ('toolCallId' in p ? p.toolCallId : '')) : [])),
  )
  const calls = last.content.filter(
    (p): p is ToolCallPart => p.type === 'tool-call' && !p.providerExecuted && !isAsk(p.toolName) && !answered.has(p.toolCallId),
  )
  if (!calls.length) return []
  return [
    {
      role: 'tool',
      content: calls.map((c) => ({
        type: 'tool-result' as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        output: { type: 'error-text' as const, value: 'Not run: the reply hit its output limit before this call could run.' },
      })),
    },
  ]
}
