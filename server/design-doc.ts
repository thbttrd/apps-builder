/**
 * DESIGN.md's text: the sections the model writes, the front matter code reads off the picked
 * page, the file they make together, the notes that ask for it, and the picked page's theme as
 * the app's src/app.css. What happens to it — saved, approved, undone — is design.ts's.
 */
import { z } from 'zod'
import { catalogName } from './design-catalog'
import type { Part, TextStyle } from './design-measure'
import type { Design, Example } from './design'

/** The example the person picked, while it is picked. */
export const pickedOf = (design: Design) => design.examples?.find((e) => e.id === design.picked?.id && e.status === 'passed')

// ── DESIGN.md ───────────────────────────────────────────────────────────────
// The picked example written down, in the catalog's format: YAML front matter, then prose
// sections. Code writes the front matter from what the check read off the page, so its colours,
// type styles and components are the page's; the model writes the prose, a field a section, so
// none can be left out. The person approves it, and approve() puts it into the app.

/**
 * A list of rules, also taken as one string — a line a rule, or a JSON array in a string:
 * glm-5.3-flash sent both lists as strings, and the schema's refusal cost it a step (dev,
 * 2026-09-27). Refusing a shape code can read is a step for nothing. Each rule without the
 * bullet or number the model wrote it with, whichever the shape: DESIGN.md and the card add their own.
 */
const rules = (about: string) =>
  z
    .union([
      z.array(z.string()).min(1),
      z.string().transform((s) => {
        const t = s.trim()
        if (t.startsWith('[')) {
          try {
            const a = JSON.parse(t) as unknown
            if (Array.isArray(a) && a.every((x) => typeof x === 'string')) return a as string[]
          } catch {
            // not JSON: lines, below
          }
        }
        return t.split('\n')
      }),
    ])
    .transform((lines) => lines.map((l) => l.replace(/^\s*(?:[-*•]\s*|\d+[.)]\s+)/, '').trim()).filter(Boolean))
    .describe(about)

/** What save_design_md takes: the prose, one field a section, which code puts under its front matter. */
export const SAVE_DESIGN_MD = z.object({
  description: z.string().describe('the design in one sentence: its look and mood, for this app'),
  overview: z.string().describe('## Overview — the look, its mood and why it suits this app: a paragraph or two'),
  colors: z.string().describe('## Colors — what each colour token is for in this app, by its name, e.g. {colors.primary}'),
  typography: z.string().describe('## Typography — the fonts and each type style, and where each is used'),
  layout: z.string().describe('## Layout — the spacing, and how the main screen is arranged'),
  elevation: z.string().describe('## Elevation & Depth — surfaces, borders and shadows: what sits above what'),
  shapes: z.string().describe('## Shapes — the radii, and which elements get which'),
  components: z.string().describe("## Components — the buttons, fields and cards, and the app's own pieces, each in the tokens"),
  dos: rules("## Do's and Don'ts — the rules to keep, one a line"),
  donts: rules('…and the mistakes to avoid, one a line'),
  responsive: z.string().describe('## Responsive Behavior — the phone, the tablet and the desktop, each laid out for itself'),
})
export type DocSections = z.infer<typeof SAVE_DESIGN_MD>

/** save_design_md's description. Static, like SYSTEM. */
export const SAVE_DESIGN_MD_ABOUT =
  'Save the app’s DESIGN.md: the picked design example written down for the build, which the ' +
  'person reads and approves before anything is planned. Only when a ◆ note or a tool result asks ' +
  'for it. Code writes its front matter — the colours, fonts, type styles, radii, spacing and ' +
  'components — from the example page itself; you write the prose, one field a section, about that ' +
  'page and this app, by the front matter’s names. Name a colour by its token ({colors.primary}, ' +
  '"the primary"), never by a hex that is not one of the design’s: that save is refused. Each save ' +
  'replaces the last, so always send every section.'

/** DESIGN.md's front matter but its name and description: what the check read off the picked page. */
export type Front = {
  colors: Record<string, string>
  colorsDark?: Record<string, string>
  typography: Record<string, Record<string, string | number>>
  rounded: Record<string, string>
  spacing?: Record<string, string>
  components?: Record<string, Record<string, string | number>>
}

const SPACING = ['xs', 'sm', 'md', 'lg', 'xl', '2xl']
/** `--color-canvas: …` → `canvas: …`, for one prefix. */
const under = (vars: Record<string, string>, prefix: string) =>
  Object.fromEntries(Object.entries(vars).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]))
/** A font token's stack as the catalog writes it: `"Newsreader", serif` → `Newsreader, serif`. */
const stackOf = (v: string | undefined) =>
  (v ?? '').split(',').map((f) => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean).join(', ')

/**
 * The names DESIGN.md gives the page's type styles, the catalog's kind, from each one's font and
 * size: display-lg/md/sm and mono-* by size; in the body font, the page's own (what <body> sets)
 * `body` — or, when no text is in it, the one with the most text that is not upper case — bigger
 * ones title-*, one as big `body-strong` or `body-alt`, smaller ones `label` when upper case,
 * else body-sm, caption. A size is one name: of two or three styles at one size, the lightest
 * takes it and the heavier are `-medium` and `-strong` (GLM-5.3's page had three at 15px and two
 * at 13px, named caption-sm, caption, body-sm, caption-sm-3, caption-sm-2 before this). A name
 * that still comes twice is numbered.
 */
export function styleNames(styles: TextStyle[], own?: number): string[] {
  const names = styles.map(() => '')
  const give = (idx: number[], ladder: string[]) => {
    const sizes = [...new Set(idx.map((i) => styles[i]!.size))].sort((a, b) => b - a)
    sizes.forEach((size, k) => {
      const base = ladder[k] ?? `${ladder.at(-1)}-${k - ladder.length + 2}`
      const same = idx.filter((i) => styles[i]!.size === size).sort((a, b) => styles[a]!.weight - styles[b]!.weight)
      const weights = same.length === 1 ? [''] : same.length === 2 ? ['', '-strong'] : ['', '-medium', '-strong']
      same.forEach((i, j) => (names[i] = base + (weights[j] ?? '-strong')))
    })
  }
  const pick = (test: (s: TextStyle, i: number) => boolean) => styles.map((_, i) => i).filter((i) => test(styles[i]!, i))
  const scale = (base: string, idx: number[]) =>
    give(idx, new Set(idx.map((i) => styles[i]!.size)).size === 1 ? [base] : [`${base}-lg`, `${base}-md`, `${base}-sm`])
  scale('display', pick((s) => s.font === 'display'))
  scale('mono', pick((s) => s.font === 'mono'))
  const b =
    own !== undefined && styles[own]?.font === 'body'
      ? own
      : [styles.findIndex((s) => s.font === 'body' && !s.upper), styles.findIndex((s) => s.font === 'body')].find((i) => i >= 0) ?? -1
  if (b >= 0) {
    const body = styles[b]!
    names[b] = 'body'
    const others = (test: (s: TextStyle) => boolean) => pick((s, i) => s.font === 'body' && i !== b && test(s))
    scale('title', others((s) => s.size > body.size))
    for (const i of others((s) => s.size === body.size)) {
      names[i] = styles[i]!.weight > body.weight ? 'body-strong' : styles[i]!.weight < body.weight ? 'body-light' : 'body-alt'
    }
    give(others((s) => s.size < body.size && s.upper), ['label', 'label-sm'])
    give(others((s) => s.size < body.size && !s.upper), ['body-sm', 'caption', 'caption-sm'])
  }
  const seen = new Map<string, number>()
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1
    seen.set(n, k)
    return k > 1 ? `${n}-${k}` : n
  })
}

/**
 * The front matter, from the picked example: its colour tokens (and dark ones), its radii, and
 * what the check measured — the type styles, the spacing used most, the components. An example
 * the check did not measure (it passed before there was a DESIGN.md) gets its font tokens as its
 * typography, and no spacing or components.
 */
export function frontOf(ex: Example): Front {
  const tokens = ex.tokens ?? {}
  const m = ex.measured
  const names = m ? styleNames(m.styles, m.body) : []
  const typography: Front['typography'] = {}
  if (m?.styles.length) {
    // The catalog's order: display, then the body font, then mono, each largest first, lightest first within a size.
    const rank = { display: 0, body: 1, mono: 2 }
    const order = m.styles
      .map((_, i) => i)
      .sort((a, b) => rank[m.styles[a]!.font] - rank[m.styles[b]!.font] || m.styles[b]!.size - m.styles[a]!.size || m.styles[a]!.weight - m.styles[b]!.weight)
    order.forEach((i) => {
      const s = m.styles[i]!
      typography[names[i]!] = {
        fontFamily: stackOf(tokens[`--font-${s.font}`]),
        fontSize: `${s.size}px`,
        fontWeight: s.weight,
        lineHeight: s.lineHeight ?? 'normal',
        letterSpacing: s.tracking ? `${s.tracking}px` : 0,
        ...(s.upper ? { textTransform: 'uppercase' } : {}),
      }
    })
  } else {
    for (const f of ['display', 'body', 'mono']) if (tokens[`--font-${f}`]) typography[f] = { fontFamily: stackOf(tokens[`--font-${f}`]) }
  }
  const rounded = under(tokens, '--radius-')
  if (m?.pill) rounded.full = '9999px'
  const component = ({ style, height, ...rest }: Part) => ({
    ...rest,
    ...(height ? { height: `${height}px` } : {}),
    ...(style !== undefined && names[style] ? { typography: `{typography.${names[style]}}` } : {}),
  })
  const parts = Object.entries(m?.parts ?? {})
  const dark = ex.dark && Object.keys(ex.dark).length ? under(ex.dark, '--color-') : undefined
  return {
    colors: under(tokens, '--color-'),
    ...(dark ? { colorsDark: dark } : {}),
    typography,
    rounded,
    ...(m?.spacing.length ? { spacing: Object.fromEntries(m.spacing.map((v, i) => [SPACING[i]!, `${v}px`])) } : {}),
    ...(parts.length ? { components: Object.fromEntries(parts.map(([k, p]) => [k, component(p!)])) } : {}),
  }
}

/** A YAML scalar: plain when it reads the same that way, else double-quoted (JSON's quoting is YAML's). */
function scalar(v: string | number): string {
  if (typeof v === 'number') return String(v)
  const plain = /^[A-Za-z0-9][\w .%()/-]*$/.test(v) && !/\s$/.test(v) && !/^[\d.]+$/.test(v) && !/^(true|false|yes|no|on|off|null)$/i.test(v)
  return plain ? v : JSON.stringify(v)
}
function yamlOf(map: Record<string, unknown>, indent = ''): string[] {
  return Object.entries(map).flatMap(([k, v]) =>
    v !== null && typeof v === 'object'
      ? [`${indent}${k}:`, ...yamlOf(v as Record<string, unknown>, indent + '  ')]
      : [`${indent}${k}: ${scalar(v as string | number)}`],
  )
}

/** The front matter as YAML, between no fences: the name, the description once there is one, then code's part. */
export function frontYaml(ex: Example, app: string, description?: string): string {
  const { colors, colorsDark, typography, rounded, spacing, components } = frontOf(ex)
  return [
    'version: alpha',
    `name: ${scalar(app)}`,
    ...(description === undefined ? [] : [`description: ${scalar(description.replace(/\s+/g, ' ').trim())}`]),
    `# Read off design example ${ex.id}, "${ex.name}", based on ${catalogName(ex.from)} in the awesome-design-md catalog.`,
    ...yamlOf({
      colors,
      ...(colorsDark ? { 'colors-dark': colorsDark } : {}),
      typography,
      rounded,
      ...(spacing ? { spacing } : {}),
      ...(components ? { components } : {}),
    }),
  ].join('\n')
}

/** The whole file: code's front matter, then the model's sections under the catalog's headings. */
export function designMd(state: Design, app: string): string {
  const ex = pickedOf(state)!
  const s = state.doc!.sections!
  const section = (title: string, body: string) => [`## ${title}`, '', body.trim(), '']
  const list = (lines: string[]) => lines.map((l) => `- ${l}`)
  return [
    '---',
    frontYaml(ex, app, s.description),
    '---',
    '',
    `# ${app}: design`,
    '',
    ...section('Overview', s.overview),
    ...section('Colors', s.colors),
    ...section('Typography', s.typography),
    ...section('Layout', s.layout),
    ...section('Elevation & Depth', s.elevation),
    ...section('Shapes', s.shapes),
    ...section('Components', s.components),
    "## Do's and Don'ts",
    '',
    '### Do',
    ...list(s.dos),
    '',
    "### Don't",
    ...list(s.donts),
    '',
    ...section('Responsive Behavior', s.responsive),
  ].join('\n')
}

/** Each turn while DESIGN.md is to be written: the picked page's front matter, and the one call. */
export function draftNote(state: Design, app: string): string {
  const ex = pickedOf(state)
  if (!ex) return '◆ The picked design example is missing. Next: call save_design_md.'
  return [
    `◆ Design ${ex.id} picked: "${ex.name}", from ${catalogName(ex.from)}.`,
    'Next: DESIGN.md, the design written down for the build — the person reads it and approves it ' +
      'before anything is planned or built. Call save_design_md now, every section in the one call; your ' +
      'turn ends when it is saved. Code wrote its front matter from the page itself, below' +
      (ex.measured ? '' : ' (from its tokens alone: its type styles and components were not measured)') +
      ': describe what is there, by these names — each colour by its token, each type style and ' +
      'component as it is named — and say what each is for in this app, and how the phone, the ' +
      'tablet and the desktop each lay out the main screen.',
    '---',
    frontYaml(ex, app),
    '---',
    `The page itself, to look again: read_file .apps-builder/designs/${ex.id}.html.`,
  ].join('\n')
}

/** At the start of a turn in 'approve', when the person typed instead of approving. */
export function docReviseNote(state: Design): string {
  const ex = pickedOf(state)
  return (
    '◆ The person is reading DESIGN.md and has not approved it; this message is about it. If it asks ' +
    'for changes to the writing, call save_design_md again with every section, changed as asked. Its ' +
    `colours, fonts, radii and components are design ${ex?.id ?? ''}'s and stay as they are: if the ` +
    'person wants other ones, say that Back to the examples, beside Approve, lets them revise the ' +
    'examples or pick another — and save nothing. If it only asks something, answer in words. ' +
    'Nothing is planned or written until they approve it.'
  )
}

/**
 * src/app.css for the approved design: the picked page's :root as Tailwind's @theme, whole — the
 * project is unbuilt, so the file it replaces is the template's. The dark colours go in a plain
 * :root under the media query, never a second @theme: Tailwind 4 hoists an @theme out of it
 * (the design log › Themes).
 */
export function themeCss(ex: Example): string {
  const said = (s: string) => s.replaceAll('*/', '* /')
  const dark = Object.entries(ex.dark ?? {}).map(([k, v]) => `    ${k}: ${v};`)
  return [
    "@import 'tailwindcss';",
    '',
    '/*',
    ` * The app's look, as tokens: design ${ex.id}, "${said(ex.name ?? '')}", based on ${said(catalogName(ex.from))}, as`,
    ' * .apps-builder/DESIGN.md has it. Tailwind makes a class of each — bg-canvas, text-ink,',
    ' * font-display, rounded-md… — and the /N opacities of the colours, so changing the look is',
    ' * changing these.' + (dark.length ? ' The dark colours are plain CSS: a second @theme would not stay in its' : ''),
    ...(dark.length ? [' * media query.'] : []),
    ' */',
    '@theme {',
    ...Object.entries(ex.tokens ?? {}).map(([k, v]) => `  ${k}: ${v};`),
    ...(ex.tokens?.['--font-body'] ? ['  --default-font-family: var(--font-body);'] : []),
    ...(ex.tokens?.['--font-mono'] ? ['  --default-mono-font-family: var(--font-mono);'] : []),
    '}',
    ...(dark.length ? ['', '@media (prefers-color-scheme: dark) {', '  :root {', '    color-scheme: dark;', ...dark, '  }', '}'] : []),
    '',
  ].join('\n')
}

/**
 * The colour and font tokens of src/app.css's first @theme (`inline` or not), which themeCss writes: what
 * check_app holds an approved design's app to (OFF-DESIGN). Never the page's :root, which carries the
 * Tailwind palette variables the app uses, so `bg-red-500` would read as a token. The light ones: check_app
 * looks in light. Undefined with no colour token: held to none, every colour would be off.
 */
export function themeOf(css: string): Record<string, string> | undefined {
  const block = /@theme\b[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const theme = Object.fromEntries([...block.matchAll(/(--(?:color|font)-[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k!, v!.trim()]))
  return Object.keys(theme).some((k) => k.startsWith('--color-')) ? theme : undefined
}

export const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
