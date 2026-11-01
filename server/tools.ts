/**
 * The agent's tools: what each one does and answers, and the order a message's writes land in.
 * chat() hands them the turn's gate, plan and design.
 */
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { edit } from '../shared/diff'
import type { Gate } from '../shared/settings'
import {
  type DesignGate,
  NO_DESIGN_PHASE,
  WRITE_DESIGN,
  WRITE_DESIGN_ABOUT,
  afterSpec,
  designFirst,
  gateFor,
  holds,
  readDesign,
  takeDoc,
  takeExample,
} from './design'
import { DESIGN_ASK, QUESTION, designCard } from './design-card'
import { SAVE_DESIGN_MD, SAVE_DESIGN_MD_ABOUT, themeOf } from './design-doc'
import { checkDesign } from './design-check'
import { type Seer, VIEWPORTS, checkApp } from './pilot'
import { HELD, type Hold, PLAN, SPEC, askedPlan, gateOf } from './plan'
import { SERVICES, type Service } from './pod'
import { addService, addressOf, flushPreview, serverLog, startPreview } from './previews'
import { META_DIR, PLAN_FILE, SPEC_FILE, TURN, diffPath, listFiles, sourcePath, writeJson } from './project'
/** What add_service answers, so the model knows how to use what it has just been given. */
const USE: Record<Service, string> = {
  server: 'Write server/index.ts — export default { async fetch(req: Request) { … } } — and fetch("/api/…") from the app.',
  redis: "In server/index.ts: import { redis } from 'bun'.",
  postgres: "In server/index.ts: import { sql } from 'bun'; make the tables with create table if not exists.",
}

/**
 * What the write tools answer for a change that would make the preview's Node run the model's
 * code, as apps-builder's user on the host: vite.config.* is run by Vite, and an @plugin or
 * @config in a stylesheet is loaded by Tailwind. A PostCSS config is never looked for
 * (preview-vite.mjs). Null when the change is the app's to make. `file` is relative to the root.
 * ponytail: a list of the doors known today; the whole fix is a sandboxed preview process.
 */
function onHost(file: string, text?: string): string | null {
  if (/^vite\.config\.[cm]?[jt]s$/.test(file)) {
    return `Not written: ${file} is apps-builder's and stays as it is. Import with relative paths.`
  }
  if (text !== undefined && /@(plugin|config)\b/i.test(text)) {
    return `Not written: ${file} names an @plugin or @config, and the app takes neither. Style with @theme and utilities.`
  }
  return null
}

/**
 * `text` with old_string replaced by new_string, or why not. old_string must occur exactly once:
 * twice, and which one was meant is a guess. Replaced by slicing, not String.replace, whose `$&`
 * and `$1` in new_string would be read as patterns.
 */
export function applyEdit(text: string, old_string: string, new_string: string): { text: string } | { error: string } {
  // The schema refuses one too; here, it would never stop being found.
  if (!old_string) return { error: 'old_string is empty' }
  const at = text.indexOf(old_string)
  if (at < 0) return { error: 'old_string is not in the file — read it again and copy the lines exactly' }
  // Overlapping ones count too: 'aa' is in 'aaa' twice, and which one was meant is a guess.
  let times = 0
  for (let i = at; i >= 0; i = text.indexOf(old_string, i + 1)) times++
  if (times > 1) return { error: `old_string is in the file ${times} times — include more of the lines around it` }
  return { text: text.slice(0, at) + new_string + text.slice(at + old_string.length) }
}

/** Runs each call after the one before it, in the order they came, whether or not that one failed. */
function queue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.catch(() => {}).then(fn)
    tail = next
    return next
  }
}

/** What a turn hands its tools. chat() gives every one; the tests leave out what they do not read. */
type ToolsOf = {
  gate?: Gate
  /** The plan as saved, and whether its gate holds the build: update_plan moves both. */
  plan?: Hold
  /** Answers check_app's `look`. */
  see?: Seer
  /** Every path the turn wrote or deleted, relative to the project: its commit takes these. */
  own?: Set<string>
  /** Told when a slow tool starts, for the activity line (activity.ts). */
  runs?: (name: string, input: unknown) => void
  design?: DesignGate
  /** The app had been built before this turn. The first build's colours would be every file. */
  built?: boolean
}

/** Exported for the test suite, which runs them under the real streamText with a mock model. */
export function tools(
  slug: string,
  dir: string,
  {
    gate = 'step',
    plan = { was: null, held: false },
    see = async () => '',
    own = new Set<string>(),
    runs = () => {},
    design = gateFor('off'),
    built = true,
  }: ToolsOf = {},
) {
  // The artefacts are saved one after another, in the order the calls came: the SDK runs a
  // message's calls together, and two update_plans on one file left whichever write finished
  // last — the earlier plan, 7% of the time in a probe — while the gate had judged the later.
  const inSaveOrder = queue()
  // The plan before the turn's first hold. A later update_plan in a held turn is judged against
  // it, not against the plan the hold saved: a finish split over two calls, or a step begun in
  // the message that set the hold, is held too, not told to wrap up or build on (review of #44).
  let before = plan.was
  // A hold set by a finish lets the writes of its own message land — they can only be for the
  // steps it marks done — and holds from the next message on. A message is told by `messages`,
  // the same for every call of one response and longer for each later one.
  let finishedIn: number | undefined
  const held = (messages: readonly unknown[]) => plan.held && messages.length !== finishedIn
  // The examples are checked one at a time, in the order the calls came, so two for one id in
  // a message are judged in order, and design.json is written by one of them at a time.
  const inCheckOrder = queue()
  const save = (file: string, value: unknown) =>
    inSaveOrder(async () => {
      // The first turn can get here before anything else has made .apps-builder/.
      await mkdir(join(dir, META_DIR), { recursive: true })
      await writeJson(join(dir, file), value)
    })
  // The app's files are changed one call at a time, in the order the calls came, for the same
  // reason: edit_file reads the file it rewrites, so two edits to one file in one message — or
  // an edit beside a write — would each start from the same text, and the last to land would
  // undo the others. read_file waits its turn too. The holds are checked before this, as each
  // call starts (see update_plan).
  const change = queue()
  /** Why a change may not be made now — the design comes first, or the plan is held — or null. */
  const blocked = (messages: readonly unknown[], what: 'Not written' | 'Not added') =>
    holds(design) ? designFirst(what, design) : held(messages) ? HELD : null
  // What a write or an edit changed, kept once it has landed and in the change queue, for its
  // row in the chat (GET /diffs/:id); and what the turn found in a file before its first change
  // to it, for the code pane's colours (TURN) — except in the first build, whose files are all
  // new to the person, so its colours were the whole app in green. Neither reaches the model. A
  // failure to keep them is logged, not told to the model: the file is written.
  const befores: Record<string, string> = {}
  const changed = async (id: string, path: string, was: string, now: string) => {
    try {
      const at = diffPath(dir, id)
      // Whole or not at all: GET /diffs/:id serves the file as it is, and a torn one left the row loading.
      if (at) {
        await Bun.write(`${at}.tmp`, JSON.stringify(edit(path, was, now)))
        await rename(`${at}.tmp`, at)
      }
      if (built && !(path in befores)) {
        befores[path] = was
        // The first turn can get here before anything else has made .apps-builder/ (see save).
        await mkdir(join(dir, META_DIR), { recursive: true })
        await writeJson(join(dir, TURN), befores)
      }
    } catch (e) {
      console.error(`[agent ${slug}] diff of ${path}:`, (e as Error).message)
    }
  }
  /** A write or an edit's new text, onto disk and the turn's own, its diff kept — or why not. */
  const land = async (id: string, full: string, was: string, text: string): Promise<string | null> => {
    const path = relative(dir, full)
    const refused = onHost(path, text)
    if (refused) return refused
    await Bun.write(full, text)
    own.add(path)
    await changed(id, path, was, text)
    return null
  }
  return {
    list_files: tool({
      description: 'List every source file in the project, as paths relative to its root.',
      inputSchema: z.object({}),
      execute: async () => (await listFiles(dir)).join('\n'),
    }),
    read_file: tool({
      description: 'Read one file. Path is relative to the project root.',
      inputSchema: z.object({ path: z.string() }),
      // In the change queue, so a read in the message that edits the file sees the edit.
      execute: async ({ path }) =>
        change(async () => {
          // The design examples and DESIGN.md are the files under .apps-builder/ it may read: the
          // design phase's notes point the build at them (design.ts).
          const f = Bun.file(/^\.apps-builder\/(designs\/[ABC]\.html|DESIGN\.md)$/.test(path) ? join(dir, path) : sourcePath(dir, path))
          return (await f.exists()) ? await f.text() : `no such file: ${path}`
        }),
    }),
    write_file: tool({
      description:
        'Write a file, replacing it entirely and creating parent directories. The dev server hot-reloads it.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }, { messages, toolCallId }) =>
        blocked(messages, 'Not written') ??
        change(async () => {
          const full = sourcePath(dir, path)
          const was = await Bun.file(full).text().catch(() => '')
          return (await land(toolCallId, full, was, content)) ?? `wrote ${path} (${content.length} bytes)`
        }),
    }),
    // The patch tool. Without one, the prompt said "write whole files", and a model designed a
    // file to its last line before writing any of it: Sonnet at xhigh thought for 65,536 tokens
    // over a WebGL engine and was cut off before its first write (the design log › Output limit).
    // Claude Code's Edit shape, flat: its MultiEdit shape, with the strings inside an array, had
    // GLM write them as JSON by hand inside its XML tool calls, and the provider the price sort
    // picks (Wafer) cut them at the first quote and dropped their newlines — every multi-line
    // edit of running-fox-glm failed. Flat strings reach every provider tried as they were sent.
    edit_file: tool({
      description:
        'Change part of a file: replaces old_string, which must appear exactly once in the file, ' +
        'with new_string. One change per call; for several, make several calls — in one message ' +
        'they apply in order. The dev server hot-reloads it.',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().min(1).describe('the exact text to replace, with enough lines around it to occur once'),
        new_string: z.string().describe('what replaces it'),
      }),
      execute: async ({ path, old_string, new_string }, { messages, toolCallId }) =>
        blocked(messages, 'Not written') ??
        change(async () => {
          const full = sourcePath(dir, path)
          const file = Bun.file(full)
          if (!(await file.exists())) return `Not written: there is no ${path}. Create it with write_file.`
          const was = await file.text()
          const out = applyEdit(was, old_string, new_string)
          if ('error' in out) return `Not written, nothing changed in ${path}: ${out.error}.`
          return (await land(toolCallId, full, was, out.text)) ?? `edited ${path}`
        }),
    }),
    delete_file: tool({
      description: 'Delete a file from the project.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }, { messages }) =>
        blocked(messages, 'Not written') ??
        change(async () => {
          const full = sourcePath(dir, path)
          const refused = onHost(relative(dir, full))
          if (refused) return refused
          await rm(full, { force: true })
          own.add(relative(dir, full))
          return `deleted ${path}`
        }),
    }),
    check_app: tool({
      description:
        'Typecheck the project and load one route of the live preview in a headless browser, ' +
        'optionally at a phone or tablet size and after acting on the page. Returns type ' +
        'errors, compile errors, runtime errors, horizontal overflow, what each step did, and ' +
        'an outline of what is on the page at the end.',
      inputSchema: z.object({
        path: z.string().default('/').describe('route, e.g. "/" or "/counter"'),
        viewport: z
          .enum(Object.keys(VIEWPORTS) as [keyof typeof VIEWPORTS])
          .default('desktop')
          .describe('desktop 1280px, tablet 820px, mobile 390px wide'),
        steps: z
          .array(
            z.object({
              do: z.enum(['click', 'fill', 'press', 'wait']),
              target: z
                .string()
                .optional()
                .describe('an element as the outline prints it, e.g. button "Add" or textbox "Email"; or its visible text'),
              value: z
                .string()
                .optional()
                .describe('fill: the text to type. press: a key, e.g. "Enter". wait with no target: milliseconds'),
            }),
          )
          .max(20)
          .default([])
          .describe('done in order before the report; the first that fails stops the rest'),
        look: z
          .string()
          .optional()
          .describe(
            'a question about how the page looks after the steps, answered from a screenshot of ' +
              'the viewport — e.g. "Is the Greet button visible and readable?"',
          ),
      }),
      // The one tool slow enough to be seen running: a typecheck, a browser, and maybe a
      // second model call to look. The others finish in milliseconds.
      execute: async (input) => {
        runs('check_app', input)
        const { path, viewport, steps, look } = input
        // A stopped preview is started, as the Start button does. It used to be reported as
        // "ask the user to start it", and the model did: a dev restart stops every preview,
        // and a build stopped mid-step to ask the person for one (2026-09-26). A start that
        // fails leaves the address unset, and the report says the browser half was skipped.
        // No picture on this start: the disk holds this turn's unfinished writes. Why it failed goes in
        // the report: some reasons are the person's to act on (the cluster's quota: stop a preview).
        let why = ''
        const address =
          addressOf(slug) ??
          (await startPreview(slug, false).then(
            () => addressOf(slug),
            (e: Error) => void console.error(`[agent ${slug}] check_app could not start the preview:`, (why = e.message)),
          ))
        // The pod's /app is a copy: this turn's writes reach it before the browser looks.
        await flushPreview(slug)
        // An approved DESIGN.md holds the page to the app's @theme (OFF-DESIGN). Approved designs only: holding
        // every template app to its neutrals is a product call not made.
        const theme = (await readDesign(dir))?.doc?.approved
          ? themeOf(await Bun.file(join(dir, 'src/app.css')).text().catch(() => ''))
          : undefined
        const checked = await checkApp(dir, address?.vite, path, viewport, steps, look ? { question: look, see } : undefined, theme)
        const report = why ? `${checked}\npreview start failed: ${why}` : checked
        const log = await serverLog(slug)
        return log === null ? report : `${report}\nserver log, last lines:\n${log || '(nothing yet)'}`
      },
    }),
    add_service: tool({
      description:
        'Give the app a server (Bun, from server/index.ts, answering /api/... on its origin), or a ' +
        'database with the server beside it: redis or postgres. Only when its data must be shared ' +
        'or outlive the browser — see "A server and a database". The preview restarts.',
      inputSchema: z.object({ service: z.enum(SERVICES) }),
      execute: async ({ service }, { messages }) => {
        const no = blocked(messages, 'Not added')
        if (no) return no
        const added = await addService(slug, service)
        return `${added.length ? `Added ${added.join(' and ')}` : `The app already has ${service}`}. ${USE[service]}`
      },
    }),
    save_spec: tool({
      description:
        "Save the app's spec: who it is for and what each wants, how it looks, its screens and " +
        'the edge cases it must handle. The person reads it in the Artefacts tab. Each save ' +
        'replaces the last, so always send the whole spec.',
      inputSchema: SPEC,
      execute: async (input) => {
        await save(SPEC_FILE, input)
        return afterSpec(design)
      },
    }),
    update_plan: tool({
      description:
        'Save the build plan: every step, each with its contract and its status. The person ' +
        'watches it in the Artefacts tab. Send the whole plan each time, each title as it was ' +
        'unless the person asked for a change. The result says what to do next; do it.',
      inputSchema: PLAN,
      execute: async (input, { messages }) => {
        // Refused, not saved, until the design is chosen: the phase is known from the turn's
        // start, so it holds whatever order the calls come in — GLM sent save_spec and
        // update_plan in one message (tip-splitter-3, 2026-09-27).
        if (holds(design)) return designFirst('Plan not saved', design)
        // Decided before the first await, which is what makes a hold hold: the SDK starts a
        // message's tools in their order (Promise.all over the calls, each through the same
        // awaits), so a write later in the same message runs after this line. Measured
        // 2026-09-26: GLM sent the call that finished a step together with the next step's
        // four write_files, and all four landed before it read "stop". The suite holds it.
        const next = gateOf(gate, plan.held ? before : plan.was, input)
        if (next.hold && !plan.held) {
          before = plan.was
          if (input.steps.every((s) => s.status === 'done')) finishedIn = messages.length
        }
        plan.was = input
        plan.held ||= next.hold
        await save(PLAN_FILE, input)
        return next.say
      },
    }),
    // No execute(): the loop stops on this call and the turn ends (see ask.ts). Counts are
    // advice in the descriptions, not limits in the schema — a call that fails the schema
    // costs a step to redo, and the card draws any number.
    ask_user: tool({
      description:
        'Ask the person questions and end your turn. Each question offers options to pick ' +
        'from; they can also type an answer of their own. Their answer is the result of this ' +
        'call, on your next turn. Ask 1 to 3 questions, 2 to 4 options each.',
      // While the plan is held, code puts it in the call's own input, as ask_design's card is:
      // the chat draws it above the question, formatted, from the live event and from chat.json
      // alike, and keeps it after the answer. Parsed as the call streams in, so an update_plan
      // in the same message has not run yet and the call goes without one, as calls did before.
      inputSchema: z
        .object({ questions: z.array(QUESTION).min(1) })
        .transform((input) => (plan.held && plan.was ? { ...input, plan: askedPlan(gate, plan.was) } : input)),
    }),
    // No execute() either: the loop stops on it, as on ask_user, and the answer is the next
    // message. The card is built by code (designCard) in the transform, into the call's own
    // input, so the live card, chat.json and the answer's splice all hold code's questions,
    // while the schema the model is sent has only what it chooses. Outside the phase, the
    // refine refuses it: the SDK answers an invalid call with the error, and the loop goes on.
    ask_design: tool({
      description:
        'Ask the person the design questions and end your turn — only when a tool result tells ' +
        'you to. The questions are fixed; you choose four inspirations from the catalog, the ' +
        'options you recommend, and at most two questions of your own. Their answer is the ' +
        'result of this call, on your next turn.',
      inputSchema: DESIGN_ASK.superRefine((_, ctx) => {
        if (design.phase !== 'ask') ctx.addIssue({ code: 'custom', message: NO_DESIGN_PHASE })
      }).transform((input) => ({ ...input, questions: designCard(input) })),
    }),
    // One design example: checked in a browser by code (design-check.ts) and saved, refused
    // with what failed, or dropped on its third refusal. Out of the phase it refuses in words,
    // not by schema: a call that fails its schema is not a step that says what to do instead.
    write_design: tool({
      description: WRITE_DESIGN_ABOUT,
      inputSchema: WRITE_DESIGN,
      execute: (input) =>
        inCheckOrder(() => {
          runs('write_design', input)
          return takeExample(dir, design, input, checkDesign)
        }),
    }),
    // DESIGN.md's prose, a field a section, under front matter code reads off the picked page.
    // Refused in words out of the phase, like write_design; one at a time, like the examples.
    save_design_md: tool({
      description: SAVE_DESIGN_MD_ABOUT,
      inputSchema: SAVE_DESIGN_MD,
      execute: (input) => inCheckOrder(() => takeDoc(dir, design, input)),
    }),
  }
}
