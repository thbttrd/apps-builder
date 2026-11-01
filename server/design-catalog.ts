/**
 * The design catalog: VoltAgent's awesome-design-md (MIT), indexed in design/catalog.json by
 * scripts/design-catalog.ts — each design's name, tokens and Google Fonts stand-ins — and what
 * reads it: a design by its slug or its name, its fonts' stylesheet, its :root.
 */
import catalogFile from './design/catalog.json'

export type Font = { family: string; was: string }
export type Entry = {
  slug: string
  name: string
  category: string
  blurb: string
  theme: 'light' | 'dark'
  swatches: string[]
  /** By role: canvas, surface, ink, ink-muted, primary, on-primary, hairline, and maybe accent. */
  tokens: Record<string, string>
  radius: { sm: string; md: string; lg: string }
  fonts: { display: Font; body: Font; mono?: Font }
}
const catalog = catalogFile as unknown as {
  google: Record<string, { generic: string; weights: number[] }>
  entries: Entry[]
}
export const CATALOG: Entry[] = catalog.entries
export const GOOGLE = catalog.google
/** A catalog design by its slug, as design.json and the brief keep it. */
export const bySlug = (slug: string | null | undefined): Entry | undefined => CATALOG.find((e) => e.slug === slug)
/** A catalog design's name, or the slug when the catalog no longer has it. */
export const catalogName = (slug: string) => bySlug(slug)?.name ?? slug

export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
/** A catalog entry by its slug or its name, however it was typed. */
export function entryOf(name: string): Entry | undefined {
  const k = squash(name)
  return k ? CATALOG.find((e) => squash(e.slug) === k || squash(e.name) === k) : undefined
}

/** The Google Fonts stylesheet for these families, each with every weight Google has of it. */
export function fontsLink(families: string[]): string {
  const q = [...new Set(families)]
    .map((f) => `family=${f.replaceAll(' ', '+')}:wght@${(GOOGLE[f]?.weights ?? [400]).join(';')}`)
    .join('&')
  return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${q}&display=swap">`
}

const stack = (f: Font) => `"${f.family}", ${GOOGLE[f.family]?.generic ?? 'sans-serif'}`

/** A catalog design's :root, as an example declares it: what code hands the model to start from. */
export function rootOf(e: Entry): string {
  const lines = [
    ...Object.entries(e.tokens).map(([role, v]) => `--color-${role}: ${v};`),
    `--font-display: ${stack(e.fonts.display)};`,
    `--font-body: ${stack(e.fonts.body)};`,
    ...(e.fonts.mono ? [`--font-mono: ${stack(e.fonts.mono)};`] : []),
    `--radius-sm: ${e.radius.sm};`,
    `--radius-md: ${e.radius.md};`,
    `--radius-lg: ${e.radius.lg};`,
  ]
  return `:root {\n  ${lines.join('\n  ')}\n}`
}
