/**
 * The design phase of a build, for a project with Propose design on: before it is built, the
 * person answers design questions, picks one of three design examples, approves the DESIGN.md
 * written from it, and nothing is planned or written until they have. What the phase is comes
 * from what is on disk, never from what the model says: the switch, the first build (git), and
 * design.json. The model's part is one call, ask_design, whose card code builds, then one
 * write_design per example, which code checks in a browser (design-check.ts), then
 * save_design_md, whose prose code puts under front matter it reads off the picked page;
 * everything it is told to do next comes back in tool results and notes from here. The
 * approval is code's too: it writes the design into the app (approve()).
 *
 * Its parts: the catalog (design-catalog.ts), ask_design's card (design-card.ts), and DESIGN.md's
 * text (design-doc.ts). Here, what the phase is and what moves it on.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { pending } from '../shared/ask'
import { type Rgba, near, parseHex } from './colour'
import { CATALOG, bySlug, catalogName, fontsLink, rootOf } from './design-catalog'
import { basesFor, briefOf, themeOf } from './design-card'
import {
  type DocSections,
  type Front,
  designMd,
  docReviseNote,
  draftNote,
  escapeHtml,
  frontOf,
  pickedOf,
  themeCss,
} from './design-doc'
import { COLOURS, type CheckOptions, type Checked, REQUIRED } from './design-check'
import type { Measured } from './design-measure'
import { COMMIT, checkpoint } from './git'
import { HttpError, META_DIR, SPEC_FILE, isMeta, readJson, writeJson } from './project'

/**
 * 'off': the switch is off, or the app is built — the phase is for a new app, and a built one
 * is never held for it. 'ask': the questions are not answered. 'examples': one of the three
 * examples is still to be written. 'pick': they are written, and the person has not picked.
 * 'draft': picked, and DESIGN.md is not written yet. 'approve': it is, and the person has not
 * approved it. 'done': approved — or picked before there was a DESIGN.md, or "build without
 * an example", or a brief saved before there were examples, each of which goes on as it did.
 */
export type DesignPhase = 'off' | 'ask' | 'examples' | 'pick' | 'draft' | 'approve' | 'done'

/** What the person answered, as the card sent it, the catalog design they picked, and the four offered. */
export type Brief = { answer: string; picks: Record<string, string>; inspiration: string | null; offered?: string[] }
export const IDS = ['A', 'B', 'C'] as const
export type ExampleId = (typeof IDS)[number]
/**
 * One example, as the check left it. `from` is its catalog design, chosen by code. `tries`
 * counts the writes of its latest round; `reasons` are what the last refusal said.
 */
export type Example = {
  id: ExampleId
  from: string
  status: 'waiting' | 'passed' | 'dropped'
  tries: number
  name?: string
  reasons?: string[]
  /** Its :root, as the check read it, and its dark colours for a 'both' brief. */
  tokens?: Record<string, string>
  dark?: Record<string, string>
  /** What the page is made of, as the check read it: DESIGN.md's front matter comes from it. */
  measured?: Measured
  at?: string
}
/**
 * DESIGN.md, once an example is picked: the pick route makes it `{}`, save_design_md fills in
 * the sections (`at`), the approve route marks it `approved`, and the turn after is `told`.
 * A project picked before there was a DESIGN.md has none, and goes on as it did.
 */
export type Doc = { sections?: DocSections; at?: string; approved?: string; told?: boolean }
export type Design = {
  brief?: Brief
  examples?: Example[]
  picked?: { id: ExampleId | null; at: string; told?: boolean }
  doc?: Doc
}
const DESIGN_FILE = join(META_DIR, 'design.json')
export const DESIGNS_DIR = join(META_DIR, 'designs')
/** Written by code from design.json at each save: the model reads it, the person opens it. */
export const DOC_FILE = join(META_DIR, 'DESIGN.md')

/** design.json's shape, as far as the phase and the notes read it: the rest is passed through. */
const DESIGN = z.looseObject({
  brief: z.looseObject({ answer: z.string(), picks: z.record(z.string(), z.string()), inspiration: z.string().nullable() }).optional(),
  examples: z
    .array(z.looseObject({ id: z.enum(IDS), from: z.string(), status: z.enum(['waiting', 'passed', 'dropped']), tries: z.number() }))
    .optional(),
  picked: z.looseObject({ id: z.enum(IDS).nullable(), at: z.string() }).optional(),
  doc: z.looseObject({}).optional(),
})

export async function readDesign(dir: string): Promise<Design | null> {
  // Never throws: this runs after a turn's claim, and a design.json broken by hand must not
  // leave the project "running". Unreadable, or of another shape (`"examples": {}` threw in
  // designPhase: review, #31), it is no brief, and the questions come again.
  const raw = await readJson<unknown>(join(dir, DESIGN_FILE), null).catch(() => null)
  return raw !== null && DESIGN.safeParse(raw).success ? (raw as Design) : null
}

export async function writeDesign(dir: string, design: Design): Promise<void> {
  await mkdir(join(dir, META_DIR), { recursive: true })
  await writeJson(join(dir, DESIGN_FILE), design)
}

export function designPhase(on: boolean, built: boolean, design: Design | null): DesignPhase {
  if (!on || built) return 'off'
  if (!design?.brief) return 'ask'
  if (design.picked && design.doc) return design.doc.approved ? 'done' : design.doc.at ? 'approve' : 'draft'
  if (design.picked || !design.examples) return 'done'
  return design.examples.some((e) => e.status === 'waiting') ? 'examples' : 'pick'
}

/**
 * Where a turn is in the design phase: set at its start from disk (gateFor), and moved by the
 * answer, each example's check and the pick. `state` is design.json as the turn holds it,
 * written after every change. The rest is this turn's own: in 'pick' or 'approve', a message
 * that is not an answer `revising`; the ids written, and those refused and not yet tried again;
 * and DESIGN.md's saves, refused (`docTries`) or not (`saved`).
 */
export type DesignGate = {
  phase: DesignPhase
  state: Design | null
  /** The project's name, which each example shows: its slug, in words. */
  app: string
  revising: boolean
  wrote: Set<ExampleId>
  retry: Set<ExampleId>
  /** A revision's writes of each example: its own round of three, apart from the examples' tries. */
  tries: Partial<Record<ExampleId, number>>
  saved: boolean
  docTries: number
  /**
   * Set when the turn's start wrote design.json — the brief, or a note marked told. The turn
   * then writes its messages to chat.json at once (agent.ts): a turn that ends before its first
   * step records nothing, and the note, sent once, was lost with the answer (review, #30).
   */
  moved: boolean
}

/** A turn's gate as the turn starts: its phase and design.json from disk, and nothing done yet. */
export const gateFor = (phase: DesignPhase, state: Design | null = null, app = ''): DesignGate => ({
  phase,
  state,
  app,
  revising: false,
  wrote: new Set(),
  retry: new Set(),
  tries: {},
  saved: false,
  docTries: 0,
  moved: false,
})

/** A project's name as the person reads it: `tip-splitter-3` is "Tip Splitter". */
export function appName(slug: string): string {
  return slug
    .replace(/-\d+$/, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/**
 * A turn's message, taken by the design phase as the turn starts: the gate moved, and design.json
 * with it, by what the message is — an answer to the questions saves the brief, a message while
 * the person picks or reads DESIGN.md is a revision, the first turn after an approval marks it
 * told. Returns the note that follows the message, when the phase has something to say: the
 * brief and the three examples to write; what is left, while examples are; how to revise;
 * DESIGN.md to write, once an example is picked; and what code applied, once, after the
 * approval. Null otherwise.
 */
export async function takeMessage(
  dir: string,
  past: readonly { role: string; content: unknown }[],
  message: string,
  gate: DesignGate,
): Promise<string | null> {
  const briefed = await takeBrief(dir, past, message, gate)
  if (briefed) return briefed
  const state = gate.state
  if (gate.phase === 'examples' && state) return leftNote(state)
  // Whether or not the message answers an ask_user: "which one?" answered with "B" asks for a
  // change, and was refused as no revision (review, #31). ask_design cannot be open here.
  if (gate.phase === 'pick' && state) {
    gate.revising = true
    return reviseNote(state, gate.app, await specOf(dir))
  }
  if (gate.phase === 'draft' && state) return draftNote(state, gate.app)
  if (gate.phase === 'approve' && state) {
    gate.revising = true
    return docReviseNote(state)
  }
  if (gate.phase === 'done' && state?.doc?.approved && !state.doc.told) return takeApproval(dir, gate)
  if (gate.phase === 'done' && state?.picked?.id === null && !state.picked.told) return takeNoExample(dir, gate)
  return null
}

/**
 * When `message` answers the ask_design that `past` ends on: the brief is saved here, by code
 * and not by the model, with the three examples to write and the catalog design each starts
 * from, the turn's phase moves on, and the note that says what comes next is returned — null
 * for any other message. A failed write is logged and the turn goes on as answered; the next
 * one, finding no brief, asks again.
 */
export async function takeBrief(
  dir: string,
  past: readonly { role: string; content: unknown }[],
  message: string,
  gate: DesignGate,
): Promise<string | null> {
  const open = pending(past)
  if (gate.phase !== 'ask' || !open?.names.includes('ask_design')) return null
  const brief = briefOf(open.questions, message)
  const examples: Example[] = basesFor(brief).map((e, i) => ({ id: IDS[i]!, from: e.slug, status: 'waiting', tries: 0 }))
  const { picked: _, doc: __, ...was } = (await readDesign(dir)) ?? {}
  const state: Design = { ...was, brief, examples }
  await writeDesign(dir, state).catch((e: Error) => console.error(`[design ${dir}] design.json:`, e.message))
  gate.phase = 'examples'
  gate.state = state
  gate.moved = true
  return `${briefNote(brief)}\n\n${examplesNote(state, gate.app, await specOf(dir))}`
}

const specOf = (dir: string) => readJson<SpecLike | null>(join(dir, SPEC_FILE), null).catch(() => null)

/** The catalog as save_spec's result lists it: one line an entry. */
const INDEX = CATALOG.map((e) => `${e.slug} — ${e.name} (${e.theme}): ${e.blurb}`).join('\n')

/** What save_spec answers: saved, and the design phase's next step while one is open. */
export function afterSpec(gate: DesignGate): string {
  const saved = 'Saved; the person can read it in the Artefacts tab.'
  if (gate.phase === 'ask') {
    return (
      `${saved} The design comes next: call ask_design now, before update_plan or any file — both are ` +
      'refused until the person has answered it. For its inspirations, pick four designs from this ' +
      `catalog that suit the app and differ from each other in mood or theme:\n${INDEX}`
    )
  }
  if (gate.phase === 'examples') return `${saved} ${nextOf(gate.state)}`
  if (gate.phase === 'draft') return `${saved} Next: call save_design_md, as the ◆ note says.`
  return saved
}

/** Whether update_plan, write_file, edit_file and delete_file wait for the design: every phase but off and done. */
export const holds = ({ phase }: Pick<DesignGate, 'phase'>) => phase !== 'off' && phase !== 'done'

/** What update_plan, write_file, edit_file and delete_file answer while they wait for the design. */
export function designFirst(what: 'Plan not saved' | 'Not written' | 'Not added', gate: DesignGate): string {
  if (gate.phase === 'examples') {
    return `${what}: the person picks one of three design examples before anything is planned or written. ${nextOf(gate.state)}`
  }
  if (gate.phase === 'pick') {
    return (
      `${what}: the person is choosing between the design examples, and nothing is planned or written ` +
      'until they pick one. If their message asks for changes, rewrite those examples with write_design; ' +
      'otherwise answer them in words and end your turn.'
    )
  }
  if (gate.phase === 'draft') {
    return (
      `${what}: the picked design is written down as DESIGN.md, and the person approves it, before ` +
      'anything is planned or written. Call save_design_md now.'
    )
  }
  if (gate.phase === 'approve') {
    return (
      `${what}: the person is reading DESIGN.md, and nothing is planned or written until they approve ` +
      'it. If their message asks for changes to it, call save_design_md again with every section; ' +
      'otherwise answer them in words and end your turn.'
    )
  }
  return (
    `${what}: this project proposes a design before it is built, and the design questions are ` +
    'not answered yet. Call ask_design now; this works once the person has answered it.'
  )
}

/** What ask_design is refused with outside the phase. */
export const NO_DESIGN_PHASE =
  'ask_design is only for the design phase, and it is not open in this project: its Propose ' +
  'design switch is off, the app is already built, or the questions were answered. Carry on.'

/** The next example to write, as an instruction: the first still waiting. */
function nextOf(state: Design | null | undefined): string {
  const waiting = (state?.examples ?? []).filter((e) => e.status === 'waiting').map((e) => e.id)
  if (!waiting.length) return 'All three examples are written; the person picks one now.'
  if (waiting.length === 1) return `Call write_design for design ${waiting[0]} now.`
  return `Call write_design for designs ${waiting.join(' and ').replace(/ and (?=.* and )/, ', ')} now, all in one message.`
}

/** The brief as the note repeats it: the picks, and the inspiration's palette. */
function briefNote(brief: Brief): string {
  const e = bySlug(brief.inspiration)
  const picks = Object.entries(brief.picks).map(([k, v]) => `${k}: ${v}`)
  return [
    '◆ Design brief saved.',
    ...(picks.length ? [picks.join(' · ')] : []),
    ...(e ? [`${e.name} — ${e.blurb}. Its palette: ${e.swatches.join(', ')}.`] : []),
  ].join('\n')
}

type SpecLike = { screens?: { name?: string; purpose?: string }[]; layouts?: { phone?: string; desktop?: string } }

/**
 * What follows the brief: the three examples to write, each with its catalog design's :root
 * and fonts, ready to paste — code builds what it can, so the model's part is the page.
 */
export function examplesNote(state: Design, app: string, spec: SpecLike | null): string {
  const brief = state.brief!
  const theme = themeOf(brief)
  const screen = spec?.screens?.[0]
  const look = [brief.picks.Mood, brief.picks.Density].filter((x) => x && x !== 'no preference').join(', ')
  const lines = [
    // "write_design, not write_file": glm-5.3-flash's first move was write_file design-a.html
    // (refused, one step lost, dev 2026-09-27).
    'Next: three design examples for the person to choose from — A, B and C, one write_design call ' +
      'each (write_design, not write_file: they are not files of the app), all three in one message. ' +
      'Each is one whole HTML page: the main screen of ' +
      `"${app}"${screen?.name ? `, ${screen.name}${screen.purpose ? ` (${screen.purpose})` : ''}` : ''}, with real content, ` +
      'in one of the designs below.' +
      (spec?.layouts?.phone ? ` On a phone: ${spec.layouts.phone}` : '') +
      (spec?.layouts?.desktop ? ` On a desktop: ${spec.layouts.desktop}` : '') +
      ` Keep each design's character, fitted to the brief${look ? ` (${look})` : ''}. The page must show the app's name, "${app}".`,
  ]
  if (theme === 'both') {
    lines.push(
      'The brief asks for light and dark, following the device: in each example, :root holds the ' +
        'light palette, and @media (prefers-color-scheme: dark) { :root { … } } the dark one, with the ' +
        'same names. Where a design below is dark, its colours are the dark palette; make the light one.',
    )
  }
  for (const ex of state.examples ?? []) {
    const e = bySlug(ex.from)
    if (!e) continue
    const mine = ex.id === 'A' && brief.inspiration === e.slug
    // Each face once: Notion's display and body are both Notion Sans (seen on dev, said twice).
    const stand = [e.fonts.display, e.fonts.body].filter((f, i, all) => f.was !== f.family && all.findIndex((x) => x.was === f.was) === i)
    lines.push(
      '',
      `${ex.id} — from ${e.name}${mine ? ' (the person’s pick)' : ''}: ${e.blurb}.`,
      rootOf(e),
      fontsLink([e.fonts.display.family, e.fonts.body.family, ...(e.fonts.mono ? [e.fonts.mono.family] : [])]),
      ...(stand.length
        ? [`${e.name}'s own ${stand.map((f) => f.was).join(' and ')} ${stand.length > 1 ? 'are' : 'is'} not on Google Fonts; ${stand.map((f) => f.family).join(' and ')} stand${stand.length > 1 ? '' : 's'} in.`]
        : []),
      ...((theme === 'light' || theme === 'dark') && e.theme !== theme
        ? [`${e.name} is a ${e.theme} design and the brief asks for ${theme}: keep its primary and accent, and make the canvas, surface, ink, ink-muted and hairline ${theme}.`]
        : []),
    )
  }
  return lines.join('\n')
}

/** At the start of a turn while examples are still to be written: what is left. */
function leftNote(state: Design): string {
  const said = (state.examples ?? []).map((e) =>
    e.status === 'passed'
      ? `${e.id} passed ("${e.name}")`
      : e.status === 'dropped'
        ? `${e.id} was dropped`
        : `${e.id} is not written${e.tries ? ` (${e.tries} of 3 tries used)` : ''}`,
  )
  return `◆ The design examples are not finished: ${said.join(', ')}. ${nextOf(state)} Each is from the design the note after the brief gave it. Nothing is planned or written until the person picks one.`
}

/** At the start of a turn in 'pick', when the person typed instead of picking. */
function reviseNote(state: Design, app: string, spec: SpecLike | null): string {
  const shown = (state.examples ?? [])
    .filter((e) => e.status === 'passed')
    .map((e) => `${e.id} "${e.name}" (from ${catalogName(e.from)})`)
  // "Try again", with none to look at: "they are looking at ," it said (review, #31).
  if (!shown.length) {
    return (
      '◆ None of the design examples passed its check, and the person has not picked; this message is ' +
      'about them. To try again, write every one of them afresh, each with three new tries. If it only ' +
      `asks something, answer in words. Nothing is planned or written until they pick one.\n\n${examplesNote(state, app, spec)}`
    )
  }
  return (
    `◆ The person has not picked a design yet; they are looking at ${shown.join(', ')}, and this ` +
    'message is about them. If it asks for changes, rewrite the examples it is about with ' +
    'write_design — the same ids, all in one message; each is checked again, and the one it ' +
    'replaces stays until the new one passes. If it only asks something, answer in words. ' +
    'Nothing is planned or written until they pick one.'
  )
}

/**
 * Once, on the first turn after "Build without an example" (the pick route, when none passed):
 * no page to read tokens from, so no DESIGN.md — the build goes on from the brief.
 */
async function takeNoExample(dir: string, gate: DesignGate): Promise<string> {
  const state = gate.state!
  state.picked!.told = true
  await writeDesign(dir, state).catch((e: Error) => console.error(`[design ${dir}] design.json:`, e.message))
  gate.moved = true
  return (
    '◆ No design example was picked: the app is built from the brief. Next: call save_spec again ' +
    'with the brief in its design line — the mood, the theme, the density and the inspiration’s look ' +
    'and colours — then call update_plan.'
  )
}

/** What the model sends to write one example. */
export const WRITE_DESIGN = z.object({
  id: z.enum(IDS).describe('which example: A, B or C, as the note names them'),
  name: z.string().describe('its name for the person, in two to four words, e.g. "Warm receipt"'),
  html: z.string().describe('the whole page, from <!doctype html> to </html>'),
})
type WriteDesign = z.infer<typeof WRITE_DESIGN>

/** write_design's description: the check's rules, so a page can pass the first time. Static, like SYSTEM. */
export const WRITE_DESIGN_ABOUT =
  'Write one design example — a whole HTML page showing the app’s main screen in one of the ' +
  'designs a ◆ note gave you — for the person to compare. Only when a note or a tool result ' +
  'asks for it. It is opened in a browser and refused, with what failed, unless: ' +
  'it is a whole page (<!doctype html>, <head>, <body>) of at most 40 KB; ' +
  'it has no <script> (it is shown with scripts off) and loads nothing from outside but Google ' +
  'Fonts — draw images and icons as inline <svg> or CSS; ' +
  'its :root declares --color-canvas, --color-surface, --color-ink, --color-ink-muted, ' +
  '--color-primary, --color-on-primary and --color-hairline, each a #rrggbb hex (--color-accent ' +
  'and a few of your own are allowed, 12 at most), and --font-display, --font-body, ' +
  '--radius-sm, --radius-md and --radius-lg; ' +
  'every colour on the page is one of those tokens — a token with alpha is fine, and so is ' +
  'transparent; a shadow may also be black with alpha. The browser’s own colours are not ' +
  'tokens: style every button, input, link and checkbox yourself, with accent-color; ' +
  'all text is in var(--font-display) or var(--font-body) (or --font-mono), both loaded from ' +
  'Google Fonts and both used — buttons and inputs need font: inherit; ' +
  'the page’s background is --color-canvas, light or dark as the brief asks; ' +
  'ink on canvas and on surface has 4.5:1 contrast, ink-muted on canvas and on-primary on primary 3:1; ' +
  'it fits 390px and 1280px wide without scrolling sideways — mobile-first CSS with ' +
  '@media (min-width: 768px) and (min-width: 1024px), each width laid out for itself; ' +
  'it shows the app’s name and real content, never lorem ipsum. ' +
  'A refused example can be sent twice more; after the third refusal it is dropped.'

/** Why write_design is refused outside the examples. */
function notOpen(gate: DesignGate): string {
  if (gate.phase === 'ask') return designFirst('Not written', gate)
  if (gate.phase === 'pick') {
    return 'Not written: the person is choosing between the examples. Rewrite one only when their message asks for changes.'
  }
  if (gate.phase === 'draft' || gate.phase === 'approve') {
    return (
      'Not written: an example is picked, and the examples are closed. DESIGN.md is written from it — ' +
      (gate.phase === 'draft' ? 'call save_design_md now.' : 'if the person wants another example, Back to the examples, beside Approve, is theirs to press.')
    )
  }
  return 'write_design is only for the design examples, and they are not open in this project: its Propose design switch is off, the app is built, or a design was picked. Carry on.'
}

/**
 * One write_design: checked, then saved, refused with what failed, or dropped on its third
 * refusal. The state is written after each, so a stopped turn loses none of it. Called one at
 * a time (the tool queues them): two in one message are judged in order.
 */
export async function takeExample(
  dir: string,
  gate: DesignGate,
  input: WriteDesign,
  check: (html: string, opts: CheckOptions) => Promise<Checked>,
): Promise<string> {
  const { id, name, html } = input
  const revising = gate.phase === 'pick' && !!gate.revising
  const state = gate.state
  const ex = state?.examples?.find((e) => e.id === id)
  if ((gate.phase !== 'examples' && !revising) || !state || !ex) return notOpen(gate)
  if (!revising && ex.status !== 'waiting') {
    return `Design ${id} is ${ex.status === 'passed' ? 'done' : 'dropped'} already; this one was not checked. ${nextOf(state)}`
  }
  gate.wrote.add(id)
  const tries = (revising ? gate.tries[id] ?? 0 : ex.tries) + 1
  if (revising) gate.tries[id] = tries
  const others = (state.examples ?? [])
    .filter((e) => e.id !== id && e.status === 'passed' && e.tokens)
    .map((e) => ({ id: e.id, tokens: e.tokens! }))
  const checked = await check(html, { app: gate.app, theme: themeOf(state.brief), others })
  const notes = checked.notes.length ? `\n(${checked.notes.join('; ')}.)` : ''
  const failed = checked.reasons.map((r) => `- ${r}`).join('\n')

  if (!checked.reasons.length) {
    await saveExample(dir, id, html, checked.shots)
    Object.assign(ex, {
      status: 'passed',
      tries,
      name,
      tokens: checked.tokens,
      dark: checked.dark,
      measured: checked.measured,
      at: new Date().toISOString(),
    })
    delete ex.reasons
    if (!checked.dark || !Object.keys(checked.dark).length) delete ex.dark
    if (!checked.measured) delete ex.measured
    gate.retry.delete(id)
    await writeDesign(dir, state)
    return `Design ${id} saved as "${name}": it passes the check.${notes} ${afterward(gate)}`
  }
  if (tries < TRIES_EACH) {
    gate.retry.add(id)
    if (!revising) {
      Object.assign(ex, { tries, reasons: checked.reasons })
      await writeDesign(dir, state)
    }
    return `Design ${id} not saved: try ${tries} of ${TRIES_EACH} failed the check.\n${failed}${notes}\nFix every one of these and send write_design for ${id} again — the whole page.`
  }
  gate.retry.delete(id)
  if (revising) {
    const kept = ex.status === 'passed' ? `the person keeps the "${ex.name}" they had` : 'it stays dropped'
    return `Design ${id} not saved, and that was the third try: ${kept}. What failed:\n${failed}${notes}\n${afterward(gate)}`
  }
  Object.assign(ex, { status: 'dropped', tries, reasons: checked.reasons })
  await writeDesign(dir, state)
  return `Design ${id} dropped after ${TRIES_EACH} tries; the person will not see it. What failed the last time:\n${failed}${notes}\n${afterward(gate)}`
}
const TRIES_EACH = 3

/** What the model is told after an example settles: the next one, or that the turn is over. */
function afterward(gate: DesignGate): string {
  if (gate.phase === 'pick') {
    return gate.retry.size ? `Design ${[...gate.retry].join(' and ')} still needs another try.` : 'The person sees it now.'
  }
  const waiting = (gate.state?.examples ?? []).filter((e) => e.status === 'waiting' && !gate.retry.has(e.id))
  if (waiting.length || gate.retry.size) return nextOf(gate.state)
  return 'All three are checked; the person picks one now, and your turn ends here.'
}

/** An example's page and its pictures, under .apps-builder/designs/, replacing the last. */
async function saveExample(dir: string, id: ExampleId, html: string, shots: Record<string, Uint8Array>): Promise<void> {
  const at = join(dir, DESIGNS_DIR)
  await mkdir(at, { recursive: true })
  await Bun.write(join(at, `${id}.html`), html)
  for (const shot of SHOTS) {
    const file = join(at, `${id}-${shot}.jpg`)
    if (shots[shot]) await Bun.write(file, shots[shot])
    else await rm(file, { force: true })
  }
}
export const SHOTS = ['desktop', 'phone', 'desktop-dark', 'phone-dark'] as const

/**
 * The turn's end, for stopWhen: in 'examples', once none is waiting; in a revision, once every
 * example rewritten has passed or run out of tries; in 'draft' and 'approve', once DESIGN.md is
 * saved, or refused three times. Code ends the turn — the model is not asked to stop, and has no
 * closing words to pay for: the picker, or DESIGN.md's card, is the answer.
 */
export const designSettled = (gate: DesignGate) => (): boolean => {
  if (gate.phase === 'examples') return gate.wrote.size > 0 && !!gate.state?.examples?.every((e) => e.status !== 'waiting')
  if (gate.phase === 'pick' && gate.revising) return gate.wrote.size > 0 && !gate.retry.size
  if (gate.phase === 'draft' || gate.phase === 'approve') return gate.saved || gate.docTries >= TRIES_EACH
  return false
}

/**
 * After a turn that ended with examples still waiting — the model stopped, or was stopped:
 * with two passed, the rest are dropped and the person picks between those two, for no more
 * steps. With fewer, they wait, and the next message's note says what is left.
 */
export async function settleTurn(dir: string, gate: DesignGate): Promise<void> {
  const examples = gate.state?.examples
  if (gate.phase !== 'examples' || !examples) return
  const waiting = examples.filter((e) => e.status === 'waiting')
  if (!waiting.length || examples.filter((e) => e.status === 'passed').length < 2) return
  for (const e of waiting) {
    e.status = 'dropped'
    e.reasons = e.reasons?.length ? e.reasons : ['not written: the turn ended first']
  }
  await writeDesign(dir, gate.state!).catch((e: Error) => console.error(`[design ${dir}] design.json:`, e.message))
}

/**
 * What the Artefacts pane and the chat's cards read: the phase, each example as the person sees
 * it, and DESIGN.md once one is picked — code's front matter from the start, the sections once
 * saved.
 */
export type DesignView = {
  phase: DesignPhase
  examples: (Pick<Example, 'id' | 'from' | 'status' | 'name' | 'reasons' | 'at'> & { fromName: string; dark: boolean })[]
  picked: ExampleId | null | undefined
  doc: DocView | null
}
export type DocView = { example: ExampleId; front: Front; sections?: DocSections; at?: string; approved?: string }
export function designView(phase: DesignPhase, design: Design | null): DesignView {
  const ex = design ? pickedOf(design) : undefined
  return {
    phase,
    examples: (design?.examples ?? []).map((e) => ({
      id: e.id,
      from: e.from,
      fromName: catalogName(e.from),
      status: e.status,
      name: e.name,
      reasons: e.reasons,
      at: e.at,
      dark: !!e.dark,
    })),
    picked: design?.picked ? design.picked.id : undefined,
    doc:
      design?.doc && ex
        ? { example: ex.id, front: frontOf(ex), sections: design.doc.sections, at: design.doc.at, approved: design.doc.approved }
        : null,
  }
}

/**
 * The person's pick, from the route (routes.ts): an example that passed, or null when none did —
 * then the build goes on from the brief. Refused with a 409 outside 'pick', a 400 for any other id.
 * An example picked opens DESIGN.md (`doc`), which is what moves the phase on to 'draft'.
 * `design` is design.json as the route read it to find the phase.
 */
export async function pick(dir: string, phase: DesignPhase, design: Design | null, id: unknown): Promise<Design> {
  if (phase !== 'pick' || !design?.examples) throw new HttpError(409, 'the design examples are not waiting for a pick')
  const passed = design.examples.filter((e) => e.status === 'passed')
  if (id === null ? passed.length > 0 : !passed.some((e) => e.id === id)) {
    throw new HttpError(400, id === null ? 'an example passed: pick one of them' : `no example ${String(id)} passed the check`)
  }
  const next: Design = { ...design, picked: { id: id as ExampleId | null, at: new Date().toISOString() }, ...(id === null ? {} : { doc: {} }) }
  await writeDesign(dir, next)
  return next
}

/** Why save_design_md is refused outside 'draft' and 'approve'. */
function docNotOpen(gate: DesignGate): string {
  if (gate.phase === 'ask' || gate.phase === 'examples' || gate.phase === 'pick') {
    return `Not saved: DESIGN.md is written once the person has picked a design example, and they have not. ${designFirst('Not written', gate).replace(/^Not written: /, '')}`
  }
  return (
    'save_design_md is only for the design phase’s DESIGN.md, and it is not open in this project: its ' +
    'Propose design switch is off, the app is built, DESIGN.md is approved, or no example was picked. Carry on.'
  )
}

/**
 * One save_design_md: the sections saved and DESIGN.md written, or refused for a hex colour in
 * the prose that is none of the design's — the front matter is the page's, and the prose must
 * not paint another. Three refusals end the turn (designSettled). In 'approve' a save is a
 * revision, and replaces the last.
 */
export async function takeDoc(dir: string, gate: DesignGate, input: DocSections): Promise<string> {
  const state = gate.state
  const ex = state ? pickedOf(state) : undefined
  if ((gate.phase !== 'draft' && gate.phase !== 'approve') || !state?.doc || !ex) return docNotOpen(gate)
  const ours = [...Object.values(ex.tokens ?? {}), ...Object.values(ex.dark ?? {})]
    .map(parseHex)
    .filter((c): c is Rgba => !!c)
  const prose = [input.description, input.overview, input.colors, input.typography, input.layout, input.elevation, input.shapes, input.components, ...input.dos, ...input.donts, input.responsive].join('\n')
  const strays = [...new Set(prose.match(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi) ?? [])].filter((h) => {
    const c = parseHex(h)
    return !c || !ours.some((o) => near(o, c))
  })
  if (strays.length) {
    gate.docTries++
    const them = strays.length > 1 ? 'are' : 'is'
    return (
      `DESIGN.md not saved: it names ${strays.join(', ')}, which ${them} not one of the design's colours. ` +
      (gate.docTries >= TRIES_EACH
        ? 'That was the third try, and your turn ends here; the person sees DESIGN.md is not written.'
        : `Name each colour by its token, e.g. {colors.primary}, and send save_design_md again, every section — try ${gate.docTries} of ${TRIES_EACH}.`)
    )
  }
  state.doc.sections = input
  state.doc.at = new Date().toISOString()
  await writeDesign(dir, state)
  await Bun.write(join(dir, DOC_FILE), designMd(state, gate.app))
  gate.saved = true
  return 'DESIGN.md saved: the person reads it in the Artefacts tab, then approves it or says what to change. Your turn ends here.'
}

/** Once, on the turn the approval starts: what code put into the app, and what to build with. */
async function takeApproval(dir: string, gate: DesignGate): Promise<string> {
  const state = gate.state!
  state.doc!.told = true
  await writeDesign(dir, state).catch((e: Error) => console.error(`[design ${dir}] design.json:`, e.message))
  gate.moved = true
  const ex = pickedOf(state)
  const tokens = Object.keys(ex?.tokens ?? {})
  // Any colour but the roles every example has is one of its own, which the note names.
  const own = tokens.filter((k) => k.startsWith('--color-')).map((k) => k.slice('--color-'.length)).filter((c) => !(COLOURS as readonly string[]).includes(c))
  const dark = !!ex?.dark && Object.keys(ex.dark).length > 0
  return [
    `◆ DESIGN.md approved, and code applied it to the app: src/app.css's @theme holds design ${ex?.id}'s ` +
      `colours, fonts and radii${dark ? ', and its dark colours follow the device (prefers-color-scheme)' : ''}; ` +
      `index.html loads its fonts; APP_NAME and the <title> are "${gate.app}". AppShell's frame is in it already.`,
    'Next: call save_spec again with this design in its design line, then update_plan. Build in its tokens — ' +
      'bg-canvas, bg-surface, text-ink, text-ink-muted, bg-primary with text-on-primary, border-hairline' +
      own.map((c) => `, bg-${c} and text-${c}`).join('') +
      `, font-display, font-body${tokens.includes('--font-mono') ? ', font-mono' : ''}, rounded-sm/md/lg — never ` +
      'Tailwind’s own palette or a colour of your own, and each component as DESIGN.md’s front matter ' +
      'gives it: read_file .apps-builder/DESIGN.md.',
  ].join('\n')
}

/**
 * The approval, from the route (routes.ts): code writes the design into the app — src/app.css's
 * @theme, the picked page's fonts in index.html, the app's name in the <title> and in AppShell's
 * APP_NAME — and commits it as a design commit, which isBuilt() does not count: the workspace
 * keeps the chat alone until step 1 shows the person's app, in the design. Only the files it
 * wrote go in the commit, with .apps-builder/. Refused with a 409 outside 'approve'. `design`
 * is design.json as the route read it to find the phase.
 */
export async function approve(dir: string, phase: DesignPhase, design: Design | null, app: string): Promise<Design> {
  const ex = design ? pickedOf(design) : undefined
  if (phase !== 'approve' || !design?.doc || !ex) throw new HttpError(409, 'DESIGN.md is not waiting for approval')
  if (!REQUIRED.every((k) => ex.tokens?.[k])) throw new HttpError(409, `design ${ex.id} has no tokens to apply: go back to the examples`)
  // What each file was, to put back if the commit fails: left written and uncommitted, the next
  // turn committed them as a hand edit, which builds the app and ends the phase (review, #32).
  const was = new Map<string, string | null>()
  const put = async (path: string, text: string) => {
    const file = Bun.file(join(dir, path))
    was.set(path, (await file.exists()) ? await file.text() : null)
    await Bun.write(join(dir, path), text)
  }
  await put('src/app.css', themeCss(ex))
  const index = Bun.file(join(dir, 'index.html'))
  if (await index.exists()) {
    const page = await Bun.file(join(dir, DESIGNS_DIR, `${ex.id}.html`)).text().catch(() => '')
    const href = /<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/i.exec(page)?.[1]
    let html = (await index.text()).replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(app)}</title>`)
    if (href && !html.includes('fonts.googleapis.com')) {
      html = html.replace(/(\n[ \t]*)<\/head>/i, (_, nl: string) =>
        [
          `${nl}  <link rel="preconnect" href="https://fonts.googleapis.com" />`,
          `${nl}  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
          `${nl}  <link rel="stylesheet" href="${href}" />`,
          `${nl}</head>`,
        ].join(''),
      )
    }
    await put('index.html', html)
  }
  const shell = Bun.file(join(dir, 'src', 'AppShell.tsx'))
  if (await shell.exists()) {
    const src = await shell.text()
    const named = src.replace(/const APP_NAME = (['"`]).*?\1/, () => `const APP_NAME = '${app.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`)
    if (named !== src) await put('src/AppShell.tsx', named)
  }
  design.doc.approved = new Date().toISOString()
  await writeDesign(dir, design)
  // The files an approval writes, whether or not this one changed them: a retry after one that
  // stopped half-way found AppShell named already, and left it out of the commit.
  const sha = await checkpoint(dir, `${COMMIT.design}${ex.name}, from ${catalogName(ex.from)}`, (p) => APPLIED.includes(p) || isMeta(p))
  if (!sha) {
    for (const [path, text] of was) await (text === null ? rm(join(dir, path), { force: true }) : Bun.write(join(dir, path), text))
    delete design.doc.approved
    await writeDesign(dir, design)
    throw new HttpError(500, 'the design could not be committed, so nothing was applied: press Approve again')
  }
  return design
}
const APPLIED = ['src/app.css', 'index.html', 'src/AppShell.tsx']

/**
 * Back to the examples, from the route: the pick and its DESIGN.md are undone, and the person
 * picks again — or types, which revises the examples. Refused with a 409 outside 'draft' and 'approve'.
 */
export async function unpick(dir: string, phase: DesignPhase, design: Design | null): Promise<Design> {
  if ((phase !== 'draft' && phase !== 'approve') || !design) throw new HttpError(409, 'no design is picked to go back from')
  const { picked: _, doc: __, ...rest } = design
  await writeDesign(dir, rest)
  await rm(join(dir, DOC_FILE), { force: true })
  return rest
}
