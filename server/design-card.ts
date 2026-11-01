/**
 * ask_design's card: the questions code builds from the model's few app-specific lines — mood,
 * theme, density, and the catalog designs to start from — and the brief read back off the
 * person's answer, with the three catalog designs the examples start from.
 */
import { z } from 'zod'
import type { Question } from '../shared/ask'
import { CATALOG, type Entry, bySlug, entryOf, squash } from './design-catalog'
import type { Theme } from './design-check'
import type { Brief } from './design'

/** The brief's answer to Theme, as the check takes it: null when it was typed or left open. */
export function themeOf(brief: Brief | undefined): Theme {
  const t = brief?.picks.Theme?.toLowerCase() ?? ''
  return t.startsWith('light') ? 'light' : t.startsWith('dark') ? 'dark' : t.startsWith('both') ? 'both' : null
}

/** One question, as ask_user takes it; ask_design's extras are these too. */
export const QUESTION = z.object({
  question: z.string().describe('the whole question, ending in "?"'),
  header: z.string().describe('one or two words naming it, e.g. "Audience"'),
  options: z
    .array(
      z.object({
        label: z.string().describe('the choice, in one to five words'),
        description: z.string().optional().describe('what picking it means, in one sentence'),
      }),
    )
    .min(1),
  multiSelect: z.boolean().default(false).describe('true when several options can apply together'),
})

type Option = Question['options'][number]
const MOODS: Option[] = [
  { label: 'Calm & minimal', description: 'Quiet surfaces, generous space, one accent used sparingly.' },
  { label: 'Warm & friendly', description: 'Soft colours, rounded shapes, a welcoming tone.' },
  { label: 'Bold & vivid', description: 'Strong colour, big type, high contrast.' },
  { label: 'Premium & editorial', description: 'Refined type, a restrained palette, a magazine’s hierarchy.' },
]
const THEMES: Option[] = [
  { label: 'Light', description: 'Dark text on a light background.' },
  { label: 'Dark', description: 'Light text on a dark background.' },
  { label: 'Both, following the device', description: 'Light or dark, as the phone or computer is set.' },
]
const DENSITIES: Option[] = [
  { label: 'Airy', description: 'Large type and spacing, fewer things on a screen.' },
  { label: 'Balanced', description: 'Comfortable spacing, a normal amount on a screen.' },
  { label: 'Compact', description: 'Dense rows and small type, more on a screen at once.' },
]
/** The labels, as the model is told them: it never sees the card code builds from them. */
const labels = (options: Option[]) => options.map((o) => `"${o.label}"`).join(', ')

/** What the model sends: the only parts of the card that depend on the app. */
export const DESIGN_ASK = z.object({
  inspirations: z
    .array(z.string())
    .default([])
    .describe('four designs from the catalog save_spec listed, by slug, that suit the app and differ from each other'),
  // The labels are in the descriptions: told only "by its label", GLM-5.3 recommended "Warm"
  // and "Comfortable", which match none (2026-09-27). Still matched loosely (recommending).
  recommend: z
    .object({
      mood: z.string().optional().describe(`one of ${labels(MOODS)}`),
      theme: z.string().optional().describe(`one of ${labels(THEMES)}`),
      density: z.string().optional().describe(`one of ${labels(DENSITIES)}`),
    })
    .default({})
    .describe('the option you recommend for each question'),
  extra: z
    .array(QUESTION)
    .default([])
    .describe('at most two questions of your own about the look, only if this app needs them'),
})
type DesignAsk = z.infer<typeof DESIGN_ASK>

/** When the model names fewer than four that exist: a dark, a light, a vivid and a warm one. */
const FALLBACK = ['linear.app', 'notion', 'stripe', 'airbnb']
const NO_PREFERENCE: Option = { label: 'No preference', description: 'The builder picks from your other answers.' }
const RECOMMENDED = ' (recommended)'

/**
 * `options` with the one `pick` names first, marked, as ask_user's options are: by its label,
 * or the label's start ("Warm"), or a word of its description ("Comfortable" is Balanced's).
 */
function recommending(options: Option[], pick: string | undefined): Option[] {
  const k = pick ? squash(pick) : ''
  const by = (test: (o: Option) => boolean) => (k ? options.findIndex(test) : -1)
  let i = by((o) => squash(o.label) === k)
  if (i < 0) i = by((o) => squash(o.label).startsWith(k))
  if (i < 0) i = by((o) => squash(o.description ?? '').includes(k))
  if (i < 0) return options
  return [{ ...options[i]!, label: options[i]!.label + RECOMMENDED }, ...options.filter((_, k) => k !== i)]
}

/**
 * The card, built here from what the model sent: the same four questions every time, which
 * a weak model cannot leave out or word away. The model chooses the four inspirations, the
 * recommendations and up to two extras. A name the catalog lacks is replaced from FALLBACK
 * and extras past two are dropped, not refused: a refusal costs a step to redo.
 */
export function designCard(input: DesignAsk): Question[] {
  const chosen = [...input.inspirations, ...FALLBACK]
    .map(entryOf)
    .filter((e, i, all): e is Entry => !!e && all.findIndex((x) => x?.slug === e.slug) === i)
    .slice(0, 4)
  return [
    { header: 'Mood', question: 'What mood should the app have?', options: recommending(MOODS, input.recommend.mood), multiSelect: false },
    { header: 'Theme', question: 'Light or dark?', options: recommending(THEMES, input.recommend.theme), multiSelect: false },
    { header: 'Density', question: 'How much should fit on a screen?', options: recommending(DENSITIES, input.recommend.density), multiSelect: false },
    {
      header: 'Inspiration',
      question: 'Which of these designs is closest to the look you want?',
      options: [...chosen.map((e) => ({ label: e.name, description: e.blurb, swatches: e.swatches })), NO_PREFERENCE],
      multiSelect: false,
    },
    ...input.extra.filter((q) => !FIXED.includes(squash(q.header))).slice(0, 2),
  ]
}
const FIXED = ['mood', 'theme', 'density', 'inspiration']

/**
 * The brief, from the card's questions and the answer the person sent: the card's lines are
 * `question → picks` (answerOf in ask.ts). An answer typed instead of picked matches no line,
 * so it has no picks, and it is kept whole for the model to read. `offered` is the card's
 * four inspirations, which the examples start from.
 */
export function briefOf(questions: readonly Question[], answer: string): Brief {
  const lines = answer.split('\n')
  const picks: Record<string, string> = {}
  for (const q of questions) {
    const line = lines.find((l) => l.startsWith(`${q.question} → `))
    // The first of a header: the card's four come first, and an extra headed "Theme" took the
    // person's Dark before (review, #30).
    if (line) picks[q.header] ??= line.slice(q.question.length + 3).replaceAll(RECOMMENDED, '')
  }
  const inspiration = picks.Inspiration ? entryOf(picks.Inspiration)?.slug ?? null : null
  const offered = (questions.find((q) => q.header === 'Inspiration')?.options ?? [])
    .map((o) => entryOf(o.label)?.slug)
    .filter((s): s is string => !!s)
  return { answer, picks, inspiration, offered }
}

/**
 * The three catalog designs the examples start from, chosen here and not by the model: A is
 * the person's inspiration, or the first design offered that fits the brief's theme; B and C
 * are the other offered designs that fit it, in the model's order — it chose them to suit the
 * app and to differ. Short of three, the fallbacks, then the catalog, each from a category
 * not yet chosen. The person's own pick is kept whatever its theme: the brief's theme wins in
 * the example, and the note says so.
 */
export function basesFor(brief: Brief): Entry[] {
  const theme = themeOf(brief)
  const fits = (e: Entry) => (theme === 'light' || theme === 'dark' ? e.theme === theme : true)
  const offered = (brief.offered ?? []).map(entryOf).filter((e): e is Entry => !!e)
  const chosen: Entry[] = []
  // Nor two in one canvas and primary, which the check refuses as the same design (Uber and
  // Figma, and 24 other pairs: review, #31).
  const same = (a: Entry, b: Entry) => a.slug === b.slug || (a.tokens.canvas === b.tokens.canvas && a.tokens.primary === b.tokens.primary)
  const add = (e: Entry | undefined) => {
    if (e && chosen.length < 3 && !chosen.some((c) => same(c, e))) chosen.push(e)
  }
  add(bySlug(brief.inspiration) || offered.find(fits) || CATALOG.find(fits))
  for (const e of offered) if (fits(e)) add(e)
  const fresh = (e: Entry) => fits(e) && !chosen.some((c) => c.category === e.category)
  for (const e of FALLBACK.map(entryOf)) if (e && fresh(e)) add(e)
  for (const e of CATALOG) if (fresh(e)) add(e)
  for (const e of CATALOG) if (fits(e)) add(e)
  return chosen
}
