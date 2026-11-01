/**
 * Propose design, end to end without the server: the brief's card, the three examples code
 * checks in a real browser, and DESIGN.md built from the picked one.
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, test } from 'bun:test'
import { stepCountIs, streamText } from 'ai'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
import { type Question, answerOf } from '../shared/ask'
import { tools } from '../server/tools'
import {
  type Brief,
  type Design,
  type DesignGate,
  type Doc,
  type Example,
  IDS,
  NO_DESIGN_PHASE,
  takeMessage,
  designPhase,
  designSettled,
  examplesNote,
  gateFor,
  holds,
  pick,
  readDesign,
  settleTurn,
  takeBrief,
  takeDoc,
  takeExample,
  writeDesign,
} from '../server/design'
import { CATALOG, GOOGLE } from '../server/design-catalog'
import { DESIGN_ASK, basesFor, briefOf, designCard } from '../server/design-card'
import { type DocSections, SAVE_DESIGN_MD, frontOf, frontYaml, styleNames, themeCss, themeOf } from '../server/design-doc'
import { withoutHtml } from '../shared/ask'
import { type CheckOptions, checkDesign, offTokens } from '../server/design-check'
import { contrast, parseHex } from '../server/colour'
import { getBrowser } from '../server/pilot'
import { toolDetail } from '../shared/labels'
import { GOOD, SECTIONS, TMP, briefL, check, lit, planOf, repaint, usage } from './fixtures'

/** GOOD with a dark palette under the same names: a page for a light-and-dark brief. */
const DARK = GOOD.replace(
  '    * { box-sizing',
  '    @media (prefers-color-scheme: dark) { :root { --color-canvas: #181715; --color-surface: #252320; --color-ink: #faf9f5; --color-ink-muted: #a09d96; --color-hairline: #3a3733; } }\n    * { box-sizing',
)
const BAD = GOOD.replace('</body>', '<script>1</script></body>')
const wd = (callId: string, id: string, name: string, html: string) =>
  ({ type: 'tool-call', toolCallId: callId, toolName: 'write_design', input: JSON.stringify({ id, name, html }) }) as const
const stepOf = (...parts: object[]) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    ...parts,
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
  ] as never[]),
})
const never = stepOf({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'not asked for' }, { type: 'text-end', id: 't' })

/** The check's verdicts on GOOD and on DARK, which the examples' and DESIGN.md's tests read. */
let good: Awaited<ReturnType<typeof checkDesign>>
let both: Awaited<ReturnType<typeof checkDesign>>
beforeAll(async () => {
  good = await checkDesign(GOOD, lit)
  both = await checkDesign(DARK, { ...lit, theme: 'both' })
})

test('the design phase (server/design.ts): open until the brief, and code builds the card', async () => {
  check(
    CATALOG.length === 61 &&
      CATALOG.every((e) => e.swatches.length === 5 && (e.theme === 'light' || e.theme === 'dark') && e.name && e.blurb),
    `design: the catalog has 61 designs, each light or dark, with five colours and a line -> ${CATALOG.length}`,
  )
  const aBrief = { brief: { answer: '', picks: {}, inspiration: null } }
  check(
    designPhase(false, false, null) === 'off' && designPhase(true, true, null) === 'off' &&
      designPhase(true, false, null) === 'ask' && designPhase(true, false, aBrief) === 'done',
    'design: the phase is off when switched off or built, open until there is a brief',
  )
  // tip-splitter-3's first message: save_spec, update_plan — and here a write — together.
  // Then ask_design, with a name the catalog lacks and three extras.
  const designDir = join(TMP, 'design-check')
  const aSpec = {
    summary: 'A tip calculator.',
    personas: [{ name: 'Diner', goal: 'Split the bill.' }],
    design: 'Plain.',
    layouts: { phone: 'one column', tablet: 'two panes', desktop: 'three panes' },
    screens: [{ name: 'Split', purpose: 'split the bill' }],
    edgeCases: [],
  }
  const extra = (h: string) => ({ question: `${h}?`, header: h, options: [{ label: 'Yes' }, { label: 'No' }] })
  const designGate = gateFor('ask')
  const designModel = new MockLanguageModelV3({
    doStream: [
      {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 's', toolName: 'save_spec', input: JSON.stringify(aSpec) },
          { type: 'tool-call', toolCallId: 'p', toolName: 'update_plan', input: JSON.stringify(planOf('pending')) },
          { type: 'tool-call', toolCallId: 'w', toolName: 'write_file', input: JSON.stringify({ path: 'src/Early.tsx', content: 'x' }) },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ]),
      },
      {
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'd',
            toolName: 'ask_design',
            input: JSON.stringify({
              inspirations: ['Linear', 'no-such-design', 'stripe'],
              recommend: { mood: 'bold & vivid' },
              extra: [extra('Icons'), extra('Photos'), extra('Sounds')],
              questions: [extra('Smuggled')],
            }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ]),
      },
    ],
  })
  const designRun = streamText({
    model: designModel,
    prompt: 'a tip calculator',
    tools: tools('design-check', designDir, { design: designGate }),
    stopWhen: stepCountIs(5),
  })
  await designRun.consumeStream()
  const designSteps = await designRun.steps
  const answered = (name: string) => String(designSteps[0]?.toolResults.find((r) => r.toolName === name)?.output)
  check(
    answered('save_spec').includes('call ask_design now') && answered('save_spec').includes('linear.app — Linear (dark)'),
    `design: save_spec, while the questions are open, says ask_design comes next and lists the catalog -> ${answered('save_spec').slice(0, 90)}`,
  )
  check(
    answered('update_plan').startsWith('Plan not saved') && !(await Bun.file(join(designDir, '.apps-builder', 'plan.json')).exists()),
    `design: an update_plan in the same message is refused and not saved -> ${answered('update_plan').slice(0, 60)}`,
  )
  check(
    answered('write_file').startsWith('Not written') && !(await Bun.file(join(designDir, 'src', 'Early.tsx')).exists()),
    `design: so is a write -> ${answered('write_file').slice(0, 60)}`,
  )
  const card = (designSteps[1]?.toolCalls.find((c) => c.toolName === 'ask_design')?.input as { questions?: Question[] })?.questions ?? []
  check(
    designSteps.length === 2 && card.map((q) => q.header).join() === 'Mood,Theme,Density,Inspiration,Icons,Photos',
    `design: ask_design ends the turn on the card code built — its four, two extras, none smuggled in -> ${card.map((q) => q.header).join()}`,
  )
  const inspirations = card[3]?.options ?? []
  check(
    inspirations.map((o) => o.label).join() === 'Linear,Stripe,Notion,Airbnb,No preference' &&
      inspirations.slice(0, 4).every((o) => o.swatches?.length === 5),
    `design: a name the catalog lacks is replaced, and each design has its colours -> ${inspirations.map((o) => o.label).join()}`,
  )
  check(card[0]?.options[0]?.label === 'Bold & vivid (recommended)', `design: the recommended mood goes first, marked -> ${card[0]?.options[0]?.label}`)
  // GLM-5.3's own words on dev, which named no label: a label's start, a word of a description.
  const loose = designCard(DESIGN_ASK.parse({ recommend: { mood: 'Warm', theme: 'Light', density: 'Comfortable' } }))
    .slice(0, 3)
    .map((q) => q.options[0]?.label)
    .join(' | ')
  check(
    loose === 'Warm & friendly (recommended) | Light (recommended) | Balanced (recommended)',
    `design: a recommendation is found by a label's start or its description's words -> ${loose}`,
  )
  const sentSchema = (designModel.doStreamCalls[0]?.tools ?? []).find((x) => x.name === 'ask_design') as
    | { inputSchema?: { properties?: object } }
    | undefined
  check(
    Object.keys(sentSchema?.inputSchema?.properties ?? {}).join() === 'inspirations,recommend,extra',
    `design: the model is sent what it chooses, not the questions -> ${Object.keys(sentSchema?.inputSchema?.properties ?? {}).join()}`,
  )
  // The answer, as the card sends it: code saves the brief, and the note says what comes next.
  const asked = [{ role: 'user', content: 'a tip calculator' }, ...JSON.parse(JSON.stringify(designSteps.flatMap((s) => s.response.messages)))]
  const picked = answerOf(card, [['Bold & vivid (recommended)'], ['Dark'], [], ['Linear'], [], []])
  const briefGate = gateFor('ask')
  const briefNoteText = await takeBrief(designDir, asked, picked, briefGate)
  const stored = await readDesign(designDir)
  check(
    briefGate.phase === 'examples' && stored?.brief?.picks.Mood === 'Bold & vivid' && stored.brief.picks.Density === 'no preference' &&
      stored.brief.inspiration === 'linear.app' && stored.brief.offered?.join() === 'linear.app,stripe,notion,airbnb' &&
      !!briefNoteText?.startsWith('◆ Design brief saved.') && briefNoteText.includes('A — from Linear (the person’s pick)') &&
      briefNoteText.includes('write_design'),
    `design: the answer is saved by code, as a brief with the four offered, and the note says to write the examples -> ${JSON.stringify(stored?.brief?.picks)}`,
  )
  check(briefGate.moved === true, 'design: saving the brief marks the turn as moved on disk, so chat() keeps the answer and its note before the model runs')
  const headClash = designCard(DESIGN_ASK.parse({ extra: [{ question: 'Which season?', header: 'Theme', options: [{ label: 'Autumn' }] }, extra('Icons')] }))
  const headClashBrief = briefOf([...card.slice(0, 4), { ...card[4]!, header: 'Theme' }], answerOf([...card.slice(0, 4), { ...card[4]!, header: 'Theme' }], [[], ['Dark'], [], [], ['Yes']]))
  check(
    headClash.map((q) => q.header).join() === 'Mood,Theme,Density,Inspiration,Icons' && headClashBrief.picks.Theme === 'Dark',
    `design: an extra headed as one of the four is dropped, and a clash takes the card's own answer -> ${headClash.map((q) => q.header).join()} · ${headClashBrief.picks.Theme}`,
  )
  const shapeDir = join(TMP, 'design-shape')
  await Bun.write(join(shapeDir, '.apps-builder', 'design.json'), JSON.stringify({ brief: stored?.brief, examples: {} }))
  check((await readDesign(shapeDir)) === null, 'design: a design.json of another shape reads as none, and cannot throw after the turn\'s claim')
  await rm(shapeDir, { recursive: true, force: true })
  check(
    stored?.examples?.map((e) => `${e.id}:${e.status}`).join() === 'A:waiting,B:waiting,C:waiting' &&
      stored.examples.every((e) => CATALOG.find((x) => x.slug === e.from)?.theme === 'dark'),
    `design: with the brief, code chooses the three designs the examples start from, all dark for a dark brief -> ${stored?.examples?.map((e) => e.from).join()}`,
  )
  check(
    JSON.stringify(briefOf(card, 'Make it look like a diner menu').picks) === '{}' && (await takeBrief(designDir, asked, 'x', gateFor('done'))) === null,
    'design: a typed answer is kept whole, with no picks; and an answer outside the phase saves nothing',
  )
  // Outside the phase: ask_design is refused and the loop goes on, and writing is allowed.
  const offPhase = streamText({
    model: new MockLanguageModelV3({
      doStream: [
        {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'd', toolName: 'ask_design', input: '{}' },
            { type: 'tool-call', toolCallId: 'w', toolName: 'write_file', input: JSON.stringify({ path: 'src/Later.tsx', content: 'x' }) },
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
    tools: tools('design-check', designDir, { design: gateFor('done') }),
    stopWhen: stepCountIs(3),
  })
  await offPhase.consumeStream()
  const offSteps = await offPhase.steps
  const refusal = offSteps[0]?.content.find((p) => p.type === 'tool-error')
  check(
    offSteps.length === 2 && String((refusal as { error?: unknown } | undefined)?.error).includes(NO_DESIGN_PHASE.slice(0, 40)) &&
      (await Bun.file(join(designDir, 'src', 'Later.tsx')).exists()),
    `design: outside the phase ask_design is refused and the turn goes on, and a write lands -> ${offSteps.length} steps`,
  )
  await rm(designDir, { recursive: true, force: true })
})

test('the design examples (design-check.ts, design.ts): code checks each page, and ends the turn', async () => {
  const ratio = (a: string | undefined, b: string | undefined) => contrast(parseHex(a ?? '')!, parseHex(b ?? '')!)
  const unfit = CATALOG.filter(
    (e) =>
      !['canvas', 'surface', 'ink', 'ink-muted', 'primary', 'on-primary', 'hairline'].every((r) => parseHex(e.tokens[r] ?? '')) ||
      ratio(e.tokens.ink, e.tokens.canvas) < 4.5 ||
      ratio(e.tokens.ink, e.tokens.surface) < 4.5 ||
      ratio(e.tokens['ink-muted'], e.tokens.canvas) < 3 ||
      ratio(e.tokens['on-primary'], e.tokens.primary) < 3,
  )
  check(unfit.length === 0, `design catalog: every design's tokens pass the examples' own rules, so code's :root starts them passing -> ${unfit.map((e) => e.slug).join() || `all ${CATALOG.length}`}`)
  const stands = CATALOG.flatMap((e) => [e.fonts.display, e.fonts.body, ...(e.fonts.mono ? [e.fonts.mono] : [])])
  check(
    stands.every((f) => GOOGLE[f.family]?.weights.length) && CATALOG.every((e) => e.radius.sm && e.radius.md && e.radius.lg),
    `design catalog: each font stands in as a Google family with its weights, and each design has three radii -> ${stands.filter((f) => !GOOGLE[f.family]).map((f) => f.family).join() || `${Object.keys(GOOGLE).length} families`}`,
  )

  // Google Fonts from here: without it, whether a font loads is a note and not a refusal.
  const online = !good.notes.some((n) => n.includes('could not be reached'))
  check(
    good.reasons.length === 0 && !!good.shots.desktop?.length && !!good.shots.phone?.length && good.tokens['--color-canvas'] === '#faf9f5',
    `design check: a page in its own tokens passes, pictured at 1280 and 390 -> ${good.reasons.join(' | ') || `${good.shots.desktop?.length} + ${good.shots.phone?.length} bytes`}`,
  )
  const cases: [string, string, string, Partial<CheckOptions>?][] = [
    ['a <script>', GOOD.replace('</body>', '<script>1</script></body>'), 'has a <script>'],
    ['an image from elsewhere', GOOD.replace('<main>', '<main><img src="https://picsum.photos/20" alt="">'), 'which is refused'],
    ['a token missing', GOOD.replace('      --color-hairline: #e6dfd8;\n', ''), 'does not declare --color-hairline'],
    ['a colour token not in hex', GOOD.replace('--color-accent: #5db8a6;', '--color-accent: rgb(93 184 166);'), 'must be #rrggbb hex'],
    ["a button in the browser's colours", GOOD.replace('button, input { font: inherit; color: inherit; }', ''), 'style buttons, inputs and links yourself'],
    ["a button in the browser's font", GOOD.replace('button, input { font: inherit; color: inherit; }', ''), 'give them font: inherit'],
    ['a near miss, naming the token', GOOD.replace('.card { background: var(--color-surface);', '.card { background: #f3ece0;'), 'nearest token --color-surface'],
    ['a font Google does not have', GOOD.replace('--font-display: "Newsreader", serif;', '--font-display: "Copernicus", serif;'), 'is not loaded from Google Fonts'],
    ['a sideways scroll at 390', GOOD.replace('<main>', '<main><div style="min-width: 600px">A wide receipt</div>'), 'at 390px: HORIZONTAL SCROLL'],
    ["no app name", GOOD.replaceAll('Tip Splitter', 'Split'), '"Tip Splitter", is not on the page'],
    ['lorem ipsum', GOOD.replace('The bill</h2>', 'The bill</h2><p>Lorem ipsum dolor</p>'), 'lorem ipsum'],
    ['muted ink nobody can read', GOOD.replace('--color-ink-muted: #6c6a64;', '--color-ink-muted: #d0d0d0;'), '--color-ink-muted on --color-canvas'],
    ['a light canvas on a dark brief', GOOD, 'the brief asks for a dark app', { theme: 'dark' }],
    ['no dark palette on a light-and-dark brief', GOOD, 'declare the dark palette', { theme: 'both' }],
    ['a page over 40 KB', GOOD.replace('</body>', `<!--${'x'.repeat(41_000)}--></body>`), 'at most 40 KB'],
    ["another example's palette", GOOD, 'the canvas and primary of design A', { others: [{ id: 'A', tokens: good.tokens }] }],
    ['a self-closed <script/>', GOOD.replace('</body>', '<script/></body>'), 'has a <script>'],
    ['no background at all', GOOD.replace('html { background: var(--color-canvas); ', 'html { '), 'sets no background'],
    ['ink nobody can read on the surface', GOOD.replace('--color-surface: #efe9de;', '--color-surface: #2b2a27;'), '--color-ink on --color-surface'],
    // The colours the audit did not read (review of #29–#32), each off token now refused.
    ['an off-token text-shadow', GOOD.replace('<main>', '<main><p style="text-shadow: 0 1px 2px #ff00ff">Shadowed</p>'), '#ff00ff is not a token: text-shadow'],
    ['an off-token gradient stop', GOOD.replace('<main>', '<main><svg width="20" height="20" aria-hidden="true"><defs><linearGradient id="g"><stop offset="0" stop-color="#ff00ff"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/></svg>'), '#ff00ff is not a token: stop-color'],
    ['an off-token <use> fill', GOOD.replace('<main>', '<main><svg width="20" height="20" aria-hidden="true"><defs><symbol id="s"><path d="M0 0h10v10z"/></symbol></defs><use href="#s" fill="#ff00ff"/></svg>'), '#ff00ff is not a token: fill'],
    ['an off-token accent-color', GOOD.replace('<main>', '<main><input type="checkbox" aria-label="Paid" style="accent-color: #ff00ff">'), '#ff00ff is not a token: accent-color'],
    ["a <progress> in the browser's colours", GOOD.replace('<main>', '<main><progress value="3" max="10"></progress>'), "<progress> is drawn by the browser in its own colour"],
  ]
  const refusedAs = await Promise.all(cases.map(([, html, , o]) => checkDesign(html, { ...lit, ...o })))
  cases.forEach(([what, , expect], i) => {
    const r = refusedAs[i]!.reasons
    const hit = r.find((x) => x.includes(expect))
    check(!!hit || (!online && expect.includes('Google Fonts')), `design check refuses ${what} -> ${hit ?? (r.join(' | ') || 'it passed')}`)
  })
  // Pages that pass now and were refused: a range the browser draws with no white token to hide
  // its UA background behind, and a token at alpha as Tailwind writes it (oklab).
  const passesNow = await Promise.all([
    checkDesign(GOOD.replace('--color-on-primary: #ffffff;', '--color-on-primary: #fffaf5;'), lit),
    checkDesign(GOOD.replace('.meta { color: var(--color-ink-muted);', '.meta { color: var(--color-ink-muted); background: color-mix(in oklab, var(--color-primary) 12%, transparent);'), lit),
    // A checkbox styled from scratch: with appearance none the browser draws nothing of its own.
    checkDesign(GOOD.replace('<main>', '<main><input type="checkbox" aria-label="Paid" style="appearance: none; width: 12px; height: 12px; border: 1px solid var(--color-hairline)">'), lit),
  ])
  check(
    passesNow.every((r) => r.reasons.length === 0),
    `design check: a range the browser draws, and a token at alpha in oklab, pass -> ${passesNow.map((r) => r.reasons.join(' | ') || 'passed').join(' / ')}`,
  )
  // A check that cannot run refuses: no chromium to be found (HOME is where chromePath looks).
  await (await getBrowser()).close()
  const realHome = process.env.HOME
  process.env.HOME = join(TMP, 'no-home')
  const noChrome = await checkDesign(GOOD, lit).finally(() => (process.env.HOME = realHome))
  const seeing = await checkDesign(GOOD, lit)
  check(
    noChrome.reasons.some((r) => r.startsWith('the check could not open it (no chromium')) && Object.keys(noChrome.tokens).length === 0 && seeing.reasons.length === 0,
    `design check: a check that cannot open the page refuses it, and the next one runs -> ${noChrome.reasons.join(' | ') || 'it passed'}`,
  )
  // One font for display and body, a primary that is the ink and an on-primary that is the canvas
  // (24 and 43 of the 61): the reading names them by the part they play.
  const oneFont = await checkDesign(
    GOOD.replace('--font-display: "Newsreader", serif;', '--font-display: "DM Sans", sans-serif;')
      .replace('--color-primary: #cc785c;', '--color-primary: #141413;')
      .replace('--color-on-primary: #ffffff;', '--color-on-primary: #faf9f5;'),
    lit,
  )
  const oneNames = oneFont.measured ? styleNames(oneFont.measured.styles, oneFont.measured.body) : []
  check(
    oneNames.includes('body') && !oneNames.some((n) => n.startsWith('display')) && oneFont.measured?.parts['button-primary']?.backgroundColor === '{colors.primary}' &&
      oneFont.measured.parts['button-primary'].textColor === '{colors.on-primary}',
    `design.md: one font is the body's, and a primary that is the ink still makes button-primary -> ${oneNames.join()} · ${JSON.stringify(oneFont.measured?.parts['button-primary'])}`,
  )
  check(
    both.reasons.length === 0 && both.dark?.['--color-canvas'] === '#181715' && !!both.shots['desktop-dark'] && !!both.shots['phone-dark'],
    `design check: a light palette and a dark one under the same names pass a light-and-dark brief, pictured in each -> ${both.reasons.join(' | ') || JSON.stringify(both.dark)}`,
  )

  check(
    basesFor(briefL).map((e) => e.slug).join() === 'claude,notion,stripe',
    `design: A is the person's pick, B and C the other offered designs of the brief's theme -> ${basesFor(briefL).map((e) => e.slug).join()}`,
  )
  const briefD: Brief = { ...briefL, picks: { ...briefL.picks, Theme: 'Dark', Inspiration: 'No preference' }, inspiration: null }
  check(
    basesFor(briefD)[0]?.slug === 'linear.app' && basesFor(briefD).length === 3 && basesFor(briefD).every((e) => e.theme === 'dark'),
    `design: with no preference, a dark brief starts from the offered dark design, and code adds dark ones -> ${basesFor(briefD).map((e) => e.slug).join()}`,
  )
  const twins = basesFor({ ...briefL, picks: { ...briefL.picks, Inspiration: 'Uber' }, inspiration: 'uber', offered: ['uber', 'figma', 'notion', 'stripe'] })
  check(
    twins.map((e) => e.slug).join() === 'uber,notion,stripe',
    `design: two offered designs in one canvas and primary are not both chosen: the check would refuse the second -> ${twins.map((e) => e.slug).join()}`,
  )
  const spec1 = { screens: [{ name: 'Split', purpose: 'split the bill' }], layouts: { phone: 'one column.', desktop: 'two panes.' } }
  const bothNote = examplesNote(
    { brief: { ...briefL, picks: { ...briefL.picks, Theme: 'Both, following the device' } }, examples: basesFor(briefL).map((e, i) => ({ id: IDS[i]!, from: e.slug, status: 'waiting' as const, tries: 0 })) },
    'Tip Splitter',
    spec1,
  )
  check(
    bothNote.includes('A — from Claude (the person’s pick)') && bothNote.includes('--color-canvas: #faf9f5;') && bothNote.includes('family=Newsreader:wght@') &&
      bothNote.includes('Copernicus and StyreneB are not on Google Fonts') && bothNote.includes('"Tip Splitter", Split (split the bill)') &&
      bothNote.includes('@media (prefers-color-scheme: dark)'),
    'design: the note hands each example its design’s :root and fonts, the app’s name and screen, and the dark palette to add',
  )
  const darkNote = examplesNote({ brief: { ...briefL, picks: { ...briefL.picks, Theme: 'Dark' } }, examples: [{ id: 'A', from: 'claude', status: 'waiting', tries: 0 }] }, 'Tip Splitter', null)
  check(darkNote.includes('Claude is a light design and the brief asks for dark'), 'design: and says so when the person’s pick is of the other theme')

  // The examples' turn, under the real streamText with the real tools() and the real check: A
  // passes, B is refused twice then passes, C is refused three times; an update_plan in the
  // first message is refused. Code ends the turn on the step that settles C — the fourth
  // answer is never asked for.
  const exDir = join(TMP, 'design-examples')
  const exState: Design = { brief: briefL, examples: basesFor(briefL).map((e, i) => ({ id: IDS[i]!, from: e.slug, status: 'waiting' as const, tries: 0 })) }
  await writeDesign(exDir, exState)
  const exGate = gateFor(designPhase(true, false, exState), exState, 'Tip Splitter')
  const B_GOOD = repaint('#ffffff', '#1b61c9')
  const exModel = new MockLanguageModelV3({
    doStream: [
      stepOf(
        wd('a1', 'A', 'Warm receipt', GOOD),
        wd('b1', 'B', 'Clean ledger', BAD),
        wd('c1', 'C', 'Night shift', BAD),
        { type: 'tool-call', toolCallId: 'p', toolName: 'update_plan', input: JSON.stringify(planOf('pending')) },
      ),
      stepOf(wd('b2', 'B', 'Clean ledger', BAD), wd('c2', 'C', 'Night shift', BAD)),
      stepOf(wd('b3', 'B', 'Clean ledger', B_GOOD), wd('c3', 'C', 'Night shift', BAD)),
      never,
    ],
  })
  const exRun = streamText({
    model: exModel,
    prompt: 'go',
    tools: tools('design-examples', exDir, { design: exGate }),
    stopWhen: [stepCountIs(8), designSettled(exGate)],
  })
  await exRun.consumeStream()
  const exSteps = await exRun.steps
  const exSaved = await readDesign(exDir)
  const exSaid = (id: string) => String(exSteps.flatMap((st) => st.toolResults).find((r) => r.toolCallId === id)?.output)
  check(
    exSteps.length === 3 && exModel.doStreamCalls.length === 3,
    `design: code ends the examples' turn on the step that settles the last one -> ${exSteps.length} steps, ${exModel.doStreamCalls.length} calls`,
  )
  check(
    exSaved?.examples?.map((e) => `${e.id}:${e.status}:${e.tries}`).join() === 'A:passed:1,B:passed:3,C:dropped:3' &&
      exSaved.examples[0]?.tokens?.['--color-canvas'] === '#faf9f5' && exSaved.examples[2]?.reasons?.some((r) => r.includes('<script>')) === true,
    `design: each example's check is saved as it settles: passed, passed on its third try, dropped -> ${exSaved?.examples?.map((e) => `${e.id}:${e.status}:${e.tries}`).join()}`,
  )
  const shelved = await Promise.all(['A.html', 'A-desktop.jpg', 'A-phone.jpg', 'B.html', 'C.html'].map((n) => Bun.file(join(exDir, '.apps-builder', 'designs', n)).exists()))
  check(shelved.join() === 'true,true,true,true,false', `design: a page that passes is saved with its pictures, one dropped is not -> ${shelved.join()}`)
  check(
    exSaid('b1').includes('try 1 of 3') && exSaid('b1').includes('has a <script>') && exSaid('a1').startsWith('Design A saved as "Warm receipt"') &&
      exSaid('c3').startsWith('Design C dropped after 3 tries') && exSaid('c3').includes('your turn ends here'),
    `design: the model is told what failed, how many tries are left, and when it is over -> ${exSaid('b1').slice(0, 70)}`,
  )
  check(
    exSaid('p').startsWith('Plan not saved') && exSaid('p').includes('write_design') && !(await Bun.file(join(exDir, '.apps-builder', 'plan.json')).exists()),
    `design: a plan sent with the examples is refused and not saved -> ${exSaid('p').slice(0, 80)}`,
  )
  check(designPhase(true, false, exSaved) === 'pick', `design: with every example settled, the person picks -> ${designPhase(true, false, exSaved)}`)
  check(toolDetail('write_design', { id: 'B', name: 'Clean ledger', html: '…' }) === 'B · Clean ledger', 'design: a write_design row names its example')

  // Typed instead of picked: a revision. The note says so; B is refused once, then replaced,
  // and code ends the turn once every example rewritten is settled.
  const pickGate = gateFor(designPhase(true, false, exSaved), exSaved, 'Tip Splitter')
  const revNote = await takeMessage(exDir, [{ role: 'user', content: 'go' }], 'make B warmer', pickGate)
  check(
    pickGate.revising === true && !!revNote?.startsWith('◆ The person has not picked a design yet') && revNote.includes('B "Clean ledger" (from Notion)'),
    `design: a message instead of a pick revises, and the note says how -> ${revNote?.slice(0, 70)}`,
  )
  const askedWhich = [
    { role: 'user', content: 'make one warmer' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'q', toolName: 'ask_user', input: { questions: [{ question: 'Which one?', header: 'Example', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } }] },
  ]
  const whichGate = gateFor('pick', exSaved, 'Tip Splitter')
  await takeMessage(exDir, askedWhich, 'Which one? → B', whichGate)
  check(whichGate.revising === true, 'design: an answer to the model\'s own question while the person picks revises too')
  const revModel = new MockLanguageModelV3({
    doStream: [stepOf(wd('r1', 'B', 'Warm ledger', BAD)), stepOf(wd('r2', 'B', 'Warm ledger', repaint('#fffaf0', '#1b61c9'))), never],
  })
  const revRun = streamText({
    model: revModel,
    prompt: 'make B warmer',
    tools: tools('design-examples', exDir, { design: pickGate }),
    stopWhen: [stepCountIs(8), designSettled(pickGate)],
  })
  await revRun.consumeStream()
  const revised = await readDesign(exDir)
  check(
    (await revRun.steps).length === 2 && revised?.examples?.[1]?.name === 'Warm ledger' && revised.examples[1]?.tokens?.['--color-canvas'] === '#fffaf0',
    `design: the revision replaces B once it passes, and the turn ends there -> ${(await revRun.steps).length} steps, ${revised?.examples?.[1]?.name}`,
  )
  const fails = async (): Promise<Awaited<ReturnType<typeof checkDesign>>> => ({ reasons: ['it is wrong'], notes: [], tokens: {}, shots: {} })
  const exhausted: DesignGate = { ...gateFor('pick', await readDesign(exDir), 'Tip Splitter'), revising: true }
  let third = ''
  for (let i = 0; i < 3; i++) third = await takeExample(exDir, exhausted, { id: 'A', name: 'Other', html: '' }, fails)
  check(
    third.includes('the person keeps the "Warm receipt"') && (await readDesign(exDir))?.examples?.[0]?.name === 'Warm receipt',
    `design: a revision refused three times leaves the one the person had -> ${third.slice(0, 80)}`,
  )
  // None passed: "Try again" hands each example its design again, a dropped one stays dropped
  // after three more refusals, and Build without an example is told once.
  const noneDir = join(TMP, 'design-none')
  const droppedEx = (id: 'A' | 'B' | 'C', from: string) => ({ id, from, status: 'dropped' as const, tries: 3, reasons: ['it is wrong'] })
  const noneState: Design = { brief: briefL, examples: [droppedEx('A', 'claude'), droppedEx('B', 'notion'), droppedEx('C', 'stripe')] }
  await writeDesign(noneDir, noneState)
  const noneGate = gateFor(designPhase(true, false, noneState), noneState, 'Tip Splitter')
  const tryAgain = await takeMessage(noneDir, [{ role: 'user', content: 'go' }], 'Try the design examples again.', noneGate)
  let stays = ''
  for (let i = 0; i < 3; i++) stays = await takeExample(noneDir, noneGate, { id: 'A', name: 'Again', html: '' }, fails)
  check(
    noneGate.phase === 'pick' && noneGate.revising === true && !!tryAgain?.startsWith('◆ None of the design examples passed') && !tryAgain.includes('looking at ,') &&
      tryAgain.includes('A — from Claude') && tryAgain.includes('--color-canvas: #faf9f5;') && stays.includes('it stays dropped') && !stays.includes('undefined'),
    `design: with none passed, Try again hands each example its design again, and a third refusal leaves it dropped -> ${stays.slice(0, 70)}`,
  )
  const without = await pick(noneDir, 'pick', await readDesign(noneDir), null)
  const withoutGate = gateFor(designPhase(true, false, without), without, 'Tip Splitter')
  const withoutNote = await takeMessage(noneDir, [], 'Build it without a design example.', withoutGate)
  const withoutOnce = await takeMessage(noneDir, [], 'go on', gateFor('done', await readDesign(noneDir), 'Tip Splitter'))
  check(
    withoutGate.phase === 'done' && !!withoutNote?.startsWith('◆ No design example was picked') && withoutGate.moved === true && withoutOnce === null,
    `design: Build without an example is taken, and the next turn is told once -> ${withoutGate.phase}, ${withoutNote?.slice(0, 40)}`,
  )
  await rm(noneDir, { recursive: true, force: true })
  const unchecked = async (): Promise<never> => {
    throw new Error('checked')
  }
  const done = await takeExample(exDir, gateFor('examples', await readDesign(exDir)), { id: 'A', name: 'x', html: '' }, unchecked)
  const closed = await takeExample(exDir, gateFor('done', await readDesign(exDir)), { id: 'A', name: 'x', html: '' }, unchecked)
  check(
    done.startsWith('Design A is done already') && closed.startsWith('write_design is only for the design examples'),
    `design: an example already settled is not checked again, nor is one outside the phase -> ${done.slice(0, 40)} / ${closed.slice(0, 40)}`,
  )

  // A turn that ended with examples waiting: two passed are enough to pick from.
  const stallDir = join(TMP, 'design-stall')
  const passedEx = (id: 'A' | 'B') => ({ id, from: 'claude', status: 'passed' as const, tries: 1, name: id, tokens: {} })
  const twoPassed = gateFor('examples', { brief: briefL, examples: [passedEx('A'), passedEx('B'), { id: 'C', from: 'stripe', status: 'waiting', tries: 0 }] })
  await settleTurn(stallDir, twoPassed)
  const onePassed = gateFor('examples', { brief: briefL, examples: [passedEx('A'), { id: 'B', from: 'notion', status: 'waiting', tries: 2 }, { id: 'C', from: 'stripe', status: 'waiting', tries: 0 }] })
  await settleTurn(stallDir, onePassed)
  check(
    twoPassed.state?.examples?.[2]?.status === 'dropped' && (await readDesign(stallDir))?.examples?.[2]?.reasons?.[0]?.startsWith('not written') === true &&
      onePassed.state?.examples?.[1]?.status === 'waiting',
    'design: a turn that stops with two passed drops the rest and opens the pick; with one, they wait',
  )
  await rm(stallDir, { recursive: true, force: true })

  // Past turns' pages are cut to a line in the request; other calls are left as they were.
  const cut = JSON.stringify(
    withoutHtml([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'x', toolName: 'write_design', input: { id: 'A', name: 'n', html: GOOD } },
          { type: 'tool-call', toolCallId: 'y', toolName: 'write_file', input: { path: 'src/a.ts', content: 'kept' } },
        ],
      },
    ]),
  )
  check(
    !cut.includes('<!doctype') && cut.includes('.apps-builder/designs/A.html') && cut.includes('"content":"kept"'),
    'design: a past write_design is one line in the request, and nothing else changes',
  )
  await rm(exDir, { recursive: true, force: true })
})

test("DESIGN.md (design.ts): code's front matter, the model's sections, then the approval", async () => {
  // The check's reading of the good page, named: what DESIGN.md's front matter is made of.
  const gm = good.measured
  const gmNames = gm ? styleNames(gm.styles, gm.body) : []
  check(
    !!gm && gm.styles[gm.body ?? -1]?.size === 16 && gmNames.includes('display-lg') && gmNames.includes('body-strong') &&
      gm.parts['button-primary']?.backgroundColor === '{colors.primary}' && gm.parts.input?.border === '1px solid {colors.hairline}' &&
      gm.parts.card?.backgroundColor === '{colors.surface}' && gm.parts.card.rounded === '{rounded.lg}' && gm.spacing.length === 6,
    `design.md: the check reads the page's type styles, spacing and components, by their tokens -> ${gmNames.join()} · ${JSON.stringify(gm?.parts.card)}`,
  )
  // GLM-5.3's picked page on dev: three body-font styles at 15px, two at 13px. A size is one name.
  const ts = (font: 'display' | 'body', size: number, weight: number) => ({ font, size, weight, lineHeight: 1.5, tracking: 0, upper: false, chars: 10 })
  const glmNames = styleNames([ts('body', 16, 600), ts('body', 15, 400), ts('body', 15, 500), ts('body', 15, 600), ts('body', 13, 400), ts('body', 13, 600), ts('display', 64, 700), ts('display', 15, 700)], 0)
  check(
    glmNames.join() === 'body,body-sm,body-sm-medium,body-sm-strong,caption,caption-strong,display-lg,display-md',
    `design.md: styles of one size share its name, the heavier -medium and -strong -> ${glmNames.join(' ')}`,
  )
  const exA: Example = { id: 'A', from: 'claude', status: 'passed', tries: 1, name: 'Warm receipt', tokens: good.tokens, measured: good.measured }
  type Fm = { name: string; description: string; colors: Record<string, string>; 'colors-dark'?: Record<string, string>; typography: Record<string, { fontFamily: string; fontSize: string }>; rounded: Record<string, string>; spacing: Record<string, string>; components: Record<string, Record<string, string>> }
  const fm = Bun.YAML.parse(frontYaml(exA, 'Tip Splitter', 'Warm: cream "paper", and #cc785c for the one action.')) as Fm
  check(
    fm.name === 'Tip Splitter' && fm.description === 'Warm: cream "paper", and #cc785c for the one action.' && fm.colors.primary === '#cc785c' &&
      fm.typography['display-lg']?.fontFamily === 'Newsreader, serif' && fm.typography.body?.fontSize === '16px' && fm.rounded.lg === '12px' &&
      fm.components['button-primary']?.typography === '{typography.body-strong}' && Object.keys(fm.spacing).join() === 'xs,sm,md,lg,xl,2xl',
    `design.md: the front matter is YAML a parser reads back, in the catalog's shape -> ${Object.keys(fm).join()}`,
  )
  const unmeasured = frontOf({ ...exA, measured: undefined })
  const darkFm = Bun.YAML.parse(frontYaml({ ...exA, dark: both.dark }, 'Tip Splitter')) as Fm
  check(
    unmeasured.typography.display?.fontFamily === 'Newsreader, serif' && !unmeasured.components && !unmeasured.spacing &&
      darkFm['colors-dark']?.canvas === '#181715' && darkFm.colors.canvas === '#faf9f5',
    'design.md: an example passed before it was measured gets its font tokens alone; a light-and-dark one its dark colours',
  )
  const pickedAs = (doc?: Doc): Design => ({ brief: briefL, examples: [exA], picked: { id: 'A', at: '2026-09-27T20:00:00.000Z' }, ...(doc ? { doc } : {}) })
  check(
    [pickedAs({}), pickedAs({ at: 'x' }), pickedAs({ at: 'x', approved: 'y' }), pickedAs()].map((d) => designPhase(true, false, d)).join() ===
      'draft,approve,done,done' && holds({ phase: 'draft' }) && holds({ phase: 'approve' }),
    'design.md: picked is draft, saved is approve, approved is done — and a pick from before DESIGN.md stays done; plans wait through both',
  )

  // The turn after the pick, under the real streamText and tools(): a save that paints a colour
  // of its own is refused, a plan in the same message is refused, the second save is kept, and
  // code ends the turn there — no third call.
  const mdDir = join(TMP, 'design-doc')
  const mdState = pickedAs({})
  await writeDesign(mdDir, mdState)
  await Bun.write(join(mdDir, '.apps-builder', 'designs', 'A.html'), GOOD)
  const mdGate = gateFor(designPhase(true, false, mdState), mdState, 'Tip Splitter')
  const mdNote = await takeMessage(mdDir, [], 'Use design A: Warm receipt (from Claude).', mdGate)
  check(
    !!mdNote?.startsWith('◆ Design A picked: "Warm receipt", from Claude.\nNext: DESIGN.md') && mdNote.includes('  primary: "#cc785c"') &&
      mdNote.includes('button-primary:') && mdNote.includes('Call save_design_md now') && mdNote.includes('read_file .apps-builder/designs/A.html'),
    `design.md: after the pick, the note gives code's front matter and the one call -> ${mdNote?.split('\n')[1]?.slice(0, 60)}`,
  )
  const sd = (callId: string, input: DocSections) => ({ type: 'tool-call', toolCallId: callId, toolName: 'save_design_md', input: JSON.stringify(input) }) as const
  const mdModel = new MockLanguageModelV3({
    doStream: [
      stepOf(sd('d1', { ...SECTIONS, colors: 'The primary is #3366ff.' }), { type: 'tool-call', toolCallId: 'dp', toolName: 'update_plan', input: JSON.stringify(planOf('pending')) }),
      stepOf(sd('d2', SECTIONS)),
      never,
    ],
  })
  const mdRun = streamText({
    model: mdModel,
    prompt: 'Use design A',
    tools: tools('design-doc', mdDir, { design: mdGate }),
    stopWhen: [stepCountIs(8), designSettled(mdGate)],
  })
  await mdRun.consumeStream()
  const mdSteps = await mdRun.steps
  const mdSaid = (id: string) => String(mdSteps.flatMap((st) => st.toolResults).find((r) => r.toolCallId === id)?.output)
  const mdSaved = await readDesign(mdDir)
  check(
    mdSteps.length === 2 && mdModel.doStreamCalls.length === 2 && designPhase(true, false, mdSaved) === 'approve',
    `design.md: code ends the turn on the save, and the person approves next -> ${mdSteps.length} steps, ${designPhase(true, false, mdSaved)}`,
  )
  check(
    mdSaid('d1').includes('#3366ff, which is not one of the design') && mdSaid('d1').includes('try 1 of 3') &&
      mdSaid('dp').startsWith('Plan not saved') && mdSaid('dp').includes('save_design_md') && mdSaid('d2').startsWith('DESIGN.md saved'),
    `design.md: a colour that is none of the design's is refused, and so is a plan -> ${mdSaid('d1').slice(0, 70)}`,
  )
  const mdFile = await Bun.file(join(mdDir, '.apps-builder', 'DESIGN.md')).text()
  const [, mdFront = '', mdBody = ''] = mdFile.split(/^---$/m)
  check(
    (Bun.YAML.parse(mdFront) as Fm).description === SECTIONS.description && mdBody.includes('# Tip Splitter: design') &&
      mdBody.includes('## Elevation & Depth\n\nFlat:') && mdBody.includes("### Do\n- Keep the canvas cream.\n- Put every amount in Newsreader.") &&
      mdBody.includes("### Don't\n- Never a second accent colour.") && mdBody.includes('## Responsive Behavior'),
    'design.md: the file is code’s front matter over the sections, under the catalog’s headings',
  )
  const asText = SAVE_DESIGN_MD.parse({ ...SECTIONS, dos: '- Keep the canvas cream.\n2. Put every amount in Newsreader.\n', donts: '["Never a second accent colour."]' })
  check(
    asText.dos.join('|') === 'Keep the canvas cream.|Put every amount in Newsreader.' && asText.donts.join() === 'Never a second accent colour.',
    `design.md: the rules are taken as one string too — a line a rule, or a JSON array — not refused -> ${asText.dos.join(' | ')}`,
  )
  const decimals = SAVE_DESIGN_MD.parse({ ...SECTIONS, dos: ['1.25rem padding inside every card', '0.5px hairlines'] })
  check(
    decimals.dos.join('|') === '1.25rem padding inside every card|0.5px hairlines',
    `design.md: a rule that starts with a number keeps it — it is not a numbered item -> ${decimals.dos.join(' | ')}`,
  )
  const thrice = gateFor('draft', pickedAs({}), 'Tip Splitter')
  let third3 = ''
  for (let i = 0; i < 3; i++) third3 = await takeDoc(mdDir, thrice, { ...SECTIONS, overview: 'Grey #888888 everywhere.' })
  const unpicked = await takeDoc(mdDir, gateFor('pick', pickedAs()), SECTIONS)
  const late = await takeDoc(mdDir, gateFor('done', pickedAs({ at: 'x', approved: 'y' })), SECTIONS)
  check(
    third3.includes('That was the third try') && designSettled(thrice)() && unpicked.startsWith('Not saved: DESIGN.md is written once the person has picked') &&
      late.startsWith('save_design_md is only for'),
    `design.md: three refusals end the turn; before the pick and after the approval it is not open -> ${unpicked.slice(0, 50)} / ${late.slice(0, 40)}`,
  )
  const approving = gateFor('approve', mdSaved, 'Tip Splitter')
  const mdRevise = await takeMessage(mdDir, [{ role: 'user', content: 'go' }], 'shorter, please', approving)
  check(
    approving.revising === true && !!mdRevise?.startsWith('◆ The person is reading DESIGN.md') && mdRevise.includes('Back to the examples'),
    `design.md: a message instead of Approve revises it, and the note says colours stay the example's -> ${mdRevise?.slice(0, 50)}`,
  )
  await rm(mdDir, { recursive: true, force: true })
})


test("the live build held to the approved design (contract 5): the app's @theme, and what the page paints off it", () => {
  // What approve() writes is what check_app reads back: the light @theme, never :root, whose Tailwind
  // palette variables are the ones the app uses (bg-red-500 would read as a token).
  const css = themeCss({ id: 'A', name: 'Test', from: 'claude', tokens: { '--color-ink': '#171717', '--color-canvas': '#ffffff', '--font-body': '"Inter", sans-serif', '--radius-md': '8px' }, dark: { '--color-ink': '#fafafa' } } as never)
  const theme = themeOf(css)!
  check(theme['--color-ink'] === '#171717' && theme['--font-body'] === '"Inter", sans-serif' && !('--radius-md' in theme), `themeOf: the colour and font tokens of the light @theme -> ${JSON.stringify(theme)}`)
  const audit = { vars: {}, paints: [{ prop: 'color', value: 'rgb(255, 0, 255)', el: '<p> "Hi"' }, { prop: 'color', value: 'rgb(23, 23, 23)', el: '<p> "Ok"' }], fonts: [{ family: 'Inter, sans-serif', el: '<p>' }, { family: 'Comic Sans MS', el: '<h1> "Title"' }], faces: {}, background: '', text: '', wide: '' }
  // Tailwind's `@theme inline` is a theme too; a file with none holds the page to nothing, rather than to no tokens.
  check(themeOf('@theme inline {\n  --color-ink: #111111;\n}')?.['--color-ink'] === '#111111', 'themeOf: an @theme inline block')
  check(themeOf("@import 'tailwindcss';\n") === undefined, 'themeOf: no @theme, no theme: OFF-DESIGN is off, not every colour')
  const off = offTokens(audit, theme)
  check(off.length === 2 && off[0]!.includes('#ff00ff is not a token') && off[1]!.includes('Comic Sans MS'), `offTokens: the colour and the font off it, nothing else -> ${off.join(' | ')}`)
})
