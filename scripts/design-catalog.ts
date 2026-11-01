/**
 * Refreshes server/design/catalog.json from a clone of VoltAgent's awesome-design-md: an entry
 * for each DESIGN.md whose front matter parses — the index the design card and the examples are
 * built from. The DESIGN.md files themselves are not kept: nothing reads them (the model never
 * browses the catalog, the design log › The design questions). MIT; the licence goes beside the index.
 *
 *   git clone https://github.com/VoltAgent/awesome-design-md /tmp/adm
 *   git -C /tmp/adm checkout f696123
 *   bun scripts/design-catalog.ts /tmp/adm
 *
 * The index is derived here, once, and not at boot: the README (names, categories, blurbs)
 * is not copied, and what a card or an example needs of an entry is a few fields, not a YAML
 * parse per request.
 *
 * Each entry's `tokens` are the ones an example must declare (design-check.ts, REQUIRED), taken from
 * its palette by role and checked the way an example is (design-check.ts): ink on canvas
 * 4.5:1, ink-muted and on-primary 3:1. A role the palette lacks is mixed from the others, so
 * code hands the model a :root that already passes. Its `fonts` are Google Fonts families
 * standing in for the catalog's, most of which are proprietary (FONTS below): every one is
 * asked for at Google here, weight by weight, so a family or a weight Google does not have
 * never reaches the index — it answers 400 for either. Its `swatches`, the five colours its card
 * shows, are its tokens — canvas, surface, ink, primary, accent — topped up from its palette.
 *
 * Needs the network, for Google Fonts.
 */
import { cp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Rgba, contrast, isDark, mix, parseHex, toHex } from '../server/colour'
import type { Entry, Font } from '../server/design-catalog'

const clone = process.argv[2]
if (!clone) throw new Error('usage: bun scripts/design-catalog.ts <clone of awesome-design-md>')
const OUT = join(import.meta.dir, '..', 'server', 'design')

/**
 * Each family the catalog names for display, body or code text, and the Google Fonts family
 * that stands in for it, with the generic that follows it in a stack. Picked by the face's
 * build — geometric, grotesque, humanist, a serif's contrast — not by name. A family Google
 * has maps to itself. A name missing here stops the script, naming it.
 */
type Generic = 'sans-serif' | 'serif' | 'monospace'
const FONTS: Record<string, [string, Generic]> = {
  Inter: ['Inter', 'sans-serif'],
  'Inter Variable': ['Inter', 'sans-serif'],
  'Inter Display': ['Inter', 'sans-serif'],
  'DM Sans': ['DM Sans', 'sans-serif'],
  'DM Mono': ['DM Mono', 'monospace'],
  Geist: ['Geist', 'sans-serif'],
  'Geist Mono': ['Geist Mono', 'monospace'],
  GeistMono: ['Geist Mono', 'monospace'],
  'JetBrains Mono': ['JetBrains Mono', 'monospace'],
  'jetbrains-mono': ['JetBrains Mono', 'monospace'],
  'Source Code Pro': ['Source Code Pro', 'monospace'],
  'IBM Plex Sans': ['IBM Plex Sans', 'sans-serif'],
  'IBM Plex Sans Variable': ['IBM Plex Sans', 'sans-serif'],
  Rubik: ['Rubik', 'sans-serif'],
  'Instrument Serif': ['Instrument Serif', 'serif'],
  'Cal Sans': ['Cal Sans', 'sans-serif'],
  // System and web-safe faces: their metric-compatible or look-alike Google families.
  Arial: ['Arimo', 'sans-serif'],
  Helvetica: ['Arimo', 'sans-serif'],
  'Helvetica Neue': ['Inter', 'sans-serif'],
  'Arial Black': ['Archivo Black', 'sans-serif'],
  'Times New Roman': ['Tinos', 'serif'],
  'ui-sans-serif': ['Inter', 'sans-serif'],
  'ui-monospace': ['JetBrains Mono', 'monospace'],
  'SFMono-Regular': ['JetBrains Mono', 'monospace'],
  Monaco: ['JetBrains Mono', 'monospace'],
  'SF Pro Display': ['Inter', 'sans-serif'],
  'SF Pro Text': ['Inter', 'sans-serif'],
  'SF Pro Rounded': ['Nunito', 'sans-serif'],
  // Neo-grotesques (Helvetica, Akzidenz, Söhne and their kin).
  'Haas Groot Disp': ['Inter Tight', 'sans-serif'],
  Haas: ['Inter', 'sans-serif'],
  'NeueHaasGrotesk Display': ['Inter Tight', 'sans-serif'],
  'Helvetica Now Display Medium': ['Inter Tight', 'sans-serif'],
  'Helvetica Now Text': ['Inter', 'sans-serif'],
  'Helvetica Now Text Medium': ['Inter', 'sans-serif'],
  'sohne-var': ['Inter Tight', 'sans-serif'],
  'Unica77 Cohere Web': ['Inter', 'sans-serif'],
  CohereText: ['Inter Tight', 'sans-serif'],
  'Linear Display': ['Inter', 'sans-serif'],
  'Linear Text': ['Inter', 'sans-serif'],
  'Notion Sans': ['Inter', 'sans-serif'],
  'Pin Sans': ['Inter', 'sans-serif'],
  'Super Sans VF': ['Inter', 'sans-serif'],
  universalSans: ['Inter', 'sans-serif'],
  hashicorpSans: ['Inter', 'sans-serif'],
  figmaSans: ['Inter', 'sans-serif'],
  'WF Visual Sans Variable': ['Inter', 'sans-serif'],
  'Optimistic VF': ['Inter', 'sans-serif'],
  UberMove: ['Inter Tight', 'sans-serif'],
  UberMoveText: ['Inter', 'sans-serif'],
  CursorGothic: ['Inter Tight', 'sans-serif'],
  'basier-square': ['Inter', 'sans-serif'],
  Apercu: ['Inter', 'sans-serif'],
  abcDiatype: ['Hanken Grotesk', 'sans-serif'],
  'ABC Favorit': ['Space Grotesk', 'sans-serif'],
  'rb-freigeist-neue': ['Space Grotesk', 'sans-serif'],
  'Forma DJR Micro': ['Public Sans', 'sans-serif'],
  // Geometric sans (Futura, Circular, Walsheim, Cereal and their kin).
  'Airbnb Cereal VF': ['Plus Jakarta Sans', 'sans-serif'],
  StyreneB: ['DM Sans', 'sans-serif'],
  'GT Walsheim Framer Medium': ['Outfit', 'sans-serif'],
  'GT Walsheim Medium': ['Outfit', 'sans-serif'],
  'Euclid Circular A': ['Outfit', 'sans-serif'],
  'The Future': ['Jost', 'sans-serif'],
  'Aeonik Pro': ['Urbanist', 'sans-serif'],
  'Degular Display': ['Urbanist', 'sans-serif'],
  'Roobert PRO': ['Manrope', 'sans-serif'],
  BinanceNova: ['Manrope', 'sans-serif'],
  BinancePlex: ['IBM Plex Sans', 'sans-serif'],
  Saans: ['Figtree', 'sans-serif'],
  'Coinbase Display': ['Figtree', 'sans-serif'],
  'Coinbase Sans': ['Figtree', 'sans-serif'],
  'Wise Sans': ['Figtree', 'sans-serif'],
  NouvelR: ['Montserrat', 'sans-serif'],
  'Salesforce-Avant-Garde': ['Questrial', 'sans-serif'],
  'Salesforce-Sans': ['Lato', 'sans-serif'],
  'Plain Black': ['Archivo Black', 'sans-serif'],
  'Sentri Display': ['Rubik', 'sans-serif'],
  // Humanist sans.
  'PlayStation SST': ['Noto Sans', 'sans-serif'],
  Vodafone: ['Nunito Sans', 'sans-serif'],
  // Technical, DIN-like and squared sans.
  'BMW Type Next Latin': ['Barlow', 'sans-serif'],
  BMWTypeNextLatin: ['Barlow', 'sans-serif'],
  'BMWTypeNextLatin Light': ['Barlow', 'sans-serif'],
  'NVIDIA-EMEA': ['Barlow', 'sans-serif'],
  'D-DIN-Bold': ['Barlow', 'sans-serif'],
  'D-DIN': ['Barlow', 'sans-serif'],
  FerrariSans: ['Titillium Web', 'sans-serif'],
  'Bugatti Display': ['Syncopate', 'sans-serif'],
  'Bugatti Text Regular': ['Montserrat', 'sans-serif'],
  'Nike Futura ND': ['Anton', 'sans-serif'],
  // Serifs.
  Copernicus: ['Newsreader', 'serif'],
  'PP Editorial Old': ['Instrument Serif', 'serif'],
  'Domaine Display': ['Playfair Display', 'serif'],
  WiredDisplay: ['Playfair Display', 'serif'],
  BreveText: ['Source Serif 4', 'serif'],
  // Monospace.
  'Linear Mono': ['JetBrains Mono', 'monospace'],
  CohereMono: ['JetBrains Mono', 'monospace'],
  'Coinbase Mono': ['IBM Plex Mono', 'monospace'],
  SaansMono: ['DM Mono', 'monospace'],
  'Berkeley Mono': ['IBM Plex Mono', 'monospace'],
  'PP Neue Montreal Mono': ['DM Mono', 'monospace'],
  figmaMono: ['Roboto Mono', 'monospace'],
  WFVisualSansMono: ['Roboto Mono', 'monospace'],
  'WFVisualSans-Mono': ['Roboto Mono', 'monospace'],
  'Bugatti Monospace': ['JetBrains Mono', 'monospace'],
}
/** The weights an example may want. Each is asked for on its own: a static face has few. */
const WEIGHTS = [400, 500, 600, 700]

// The README lists each entry under its category: `- [**Linear**](https://getdesign.md/linear.app/design-md) - blurb`.
const listed = new Map<string, { name: string; category: string; blurb: string }>()
let category = ''
for (const line of (await Bun.file(join(clone, 'README.md')).text()).split('\n')) {
  const heading = line.match(/^### (.+)/)
  if (heading) category = heading[1]!.trim()
  const entry = line.match(/^- \[\*\*(.+?)\*\*\]\(https:\/\/getdesign\.md\/([^/]+)\/design-md\)\s*-\s*(.+)/)
  if (entry) listed.set(entry[2]!, { name: entry[1]!, category, blurb: entry[3]!.trim() })
}

type Colors = Record<string, unknown>
const hex = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined)
/** The first key matching each pattern, in order, whose value is a plain hex colour and passes `ok`. */
const first = (c: Colors, patterns: RegExp[], ok: (h: string) => boolean = () => true) => {
  for (const p of patterns) for (const [k, v] of Object.entries(c)) if (p.test(k) && hex(v) && ok(hex(v)!)) return hex(v)
  return undefined
}
const rgb = (h: string) => parseHex(h) as Rgba
const ratio = (a: string, b: string) => contrast(rgb(a), rgb(b))

/**
 * The colour tokens an example declares, by role, from a palette whose canvas is `canvas`.
 * Each role takes the first key that fits it and passes its check; a role no key fills is
 * mixed from the others, the way a designer would derive it, until it passes.
 */
function tokensOf(c: Colors, canvas: string) {
  const dark = isDark(rgb(canvas))
  const palette = [...new Set(Object.values(c).map(hex).filter((v): v is string => !!v))]
  const best = (min: number, against: string) =>
    palette.filter((h) => ratio(h, against) >= min).sort((a, b) => ratio(b, against) - ratio(a, against))[0]
  const blackOrWhite = (against: string) => (ratio('#ffffff', against) >= ratio('#000000', against) ? '#ffffff' : '#000000')
  /** From `from` toward `to`, in tenths, the first mix that passes `ok`. */
  const toward = (from: string, to: string, ok: (h: string) => boolean) => {
    for (let t = 0.1; t <= 1.001; t += 0.1) {
      const h = toHex(mix(rgb(from), rgb(to), t))
      if (ok(h)) return h
    }
    return to
  }

  const ink =
    first(c, [/^ink$/, /^ink/, /^text$/, /^text-primary/, /^text/, /^body-strong$/, /^body$/, ...(dark ? [/^on-dark$/, /^white$/] : [])], (h) => ratio(h, canvas) >= 4.5) ??
    best(4.5, canvas) ??
    blackOrWhite(canvas)
  const inkMuted =
    first(
      c,
      [/^ink-muted/, /^text-muted/, /^text-secondary/, /^muted$/, /^mute$/, /^body$/, /muted/, /^stone$/, /^slate$/, /^ash$/, /^steel$/, ...(dark ? [/^on-dark-mute/, /^on-dark-soft/] : [])],
      (h) => h !== ink && ratio(h, canvas) >= 3,
    ) ?? toward(canvas, ink, (h) => ratio(h, canvas) >= 3.5)
  // A surface is a card on the canvas: near it, never it, and ink still reads on it.
  const surfaceOk = (h: string) => h !== canvas && ratio(h, canvas) < 1.6 && isDark(rgb(h)) === dark && ratio(ink, h) >= 4.5
  const surface =
    first(
      c,
      dark
        ? [/^surface-dark-elevated/, /^surface-elevated/, /^surface-dark/, /^surface-card$/, /^surface$/, /^surface/, /^canvas-soft/, /^canvas-elevated/]
        : [/^surface-card$/, /^surface-soft$/, /^surface$/, /^canvas-soft$/, /^surface(?!.*dark)/],
      surfaceOk,
    ) ??
    (!dark && ratio('#ffffff', canvas) > 1.03 && ratio(ink, '#ffffff') >= 4.5
      ? '#ffffff'
      : [ink, blackOrWhite(ink)]
          // Toward ink first; on a mid-tone canvas (Nintendo's #7a8aba under dark ink) that only
          // loses contrast, so away from it.
          .map((to) => toward(canvas, to, (h) => h !== canvas && ratio(h, canvas) >= (dark ? 1.08 : 1.06) && ratio(ink, h) >= 4.5))
          .find((h) => ratio(ink, h) >= 4.5 && h !== canvas) ?? blackOrWhite(ink))
  // A primary that is the canvas itself (SpaceX, Shopify: black on black) is a button nobody
  // sees. Such brands' call to action is the inverted one: an accent that stands out, or ink.
  const named = first(c, [/^primary$/])!
  const primary =
    ratio(named, canvas) >= 1.2 ? named : first(c, [/^accent/, /^brand/, /^link$/], (h) => ratio(h, canvas) >= 3) ?? ink
  const onPrimary = first(c, [/^on-primary$/], (h) => ratio(h, primary) >= 3) ?? blackOrWhite(primary)
  // A hairline shows on the canvas without shouting: between 1.1:1 and 3:1.
  const hairline =
    first(c, [/^hairline$/, /^hairline/, /^border$/, /^border/, /divider/, /^rule/], (h) => isDark(rgb(h)) === dark && ratio(h, canvas) >= 1.1 && ratio(h, canvas) < 3) ??
    toward(canvas, ink, (h) => ratio(h, canvas) >= 1.25)
  const accent = first(c, [/^accent/, /^secondary$/, /^link$/, /^highlight/, /^brand/], (h) => h !== primary && h !== canvas && h !== ink)
  return {
    canvas,
    surface,
    ink,
    'ink-muted': inkMuted,
    primary,
    'on-primary': onPrimary,
    hairline,
    ...(accent && { accent }),
  }
}

/** A radius as CSS: `6px`, `0.5rem`; a bare number is pixels. */
const radiusOf = (v: unknown): string | undefined =>
  typeof v === 'number' ? `${v}px` : typeof v === 'string' && /^\d+(\.\d+)?(px|rem)$/.test(v.trim()) ? v.trim() : undefined

/** The first family of a typography role, by its key: display, body, code. */
function familiesOf(t: Record<string, { fontFamily?: unknown }>) {
  const fam = (k: string | undefined) =>
    k ? String(t[k]?.fontFamily ?? '').split(',')[0]!.replace(/["']/g, '').trim() || undefined : undefined
  const keys = Object.keys(t)
  const display = fam(keys.find((k) => /^(display|hero|headline|heading|h1)/.test(k)) ?? keys[0])
  const body = fam(keys.find((k) => /^body/.test(k)) ?? keys.find((k) => /^(text|paragraph)/.test(k))) ?? display
  const mono = fam(keys.find((k) => /mono|code/.test(k)))
  return { display, body, mono }
}

const entries: Entry[] = []
const skipped: string[] = []
const unmapped = new Set<string>()
const dirs = (await readdir(join(clone, 'design-md'))).sort()
for (const slug of dirs) {
  const text = await Bun.file(join(clone, 'design-md', slug, 'DESIGN.md')).text()
  const front = text.match(/^---\n([\s\S]*?)\n---/)
  let parsed: { colors?: Colors; description?: unknown; typography?: Record<string, { fontFamily?: unknown }>; rounded?: Record<string, unknown> }
  try {
    if (!front) throw new Error('no front matter')
    parsed = Bun.YAML.parse(front[1]!) as typeof parsed
  } catch (e) {
    skipped.push(`${slug} (${(e as Error).message})`)
    continue
  }
  const colors = parsed.colors ?? {}
  const description = typeof parsed.description === 'string' ? parsed.description : ''
  const canvas = first(colors, [/^canvas$/, /^canvas/, /canvas/, /^background$/])
  const ink = first(colors, [/^ink$/, /^ink/, /^text/, /^body$/])
  const primary = first(colors, [/^primary$/])
  if (!canvas || !ink || !primary) {
    skipped.push(`${slug} (no canvas, ink or primary in hex)`)
    continue
  }
  // The card's colours are the tokens an example starts from: canvas, surface, ink, primary and
  // the accent, each once; where two roles share one (Airtable's primary is its ink), the next
  // colour of the palette fills in. Picked apart from the tokens, they showed 42 of the 61
  // designs in colours their examples would not have.
  const tokens = tokensOf(colors, canvas)
  const swatches = [
    ...new Set(
      [tokens.canvas, tokens.surface, tokens.ink, tokens.primary, tokens.accent, ...Object.values(colors).map(hex)].filter(
        (v): v is string => !!v,
      ),
    ),
  ].slice(0, 5)

  const r = parsed.rounded ?? {}
  const sm = radiusOf(r.sm) ?? radiusOf(r.xs) ?? '4px'
  const md = radiusOf(r.md) ?? sm
  const lg = radiusOf(r.lg) ?? radiusOf(r.xl) ?? md

  const fams = familiesOf(parsed.typography ?? {})
  const font = (was: string | undefined): Font | undefined => {
    if (!was) return undefined
    const to = FONTS[was]
    if (!to) unmapped.add(`${was} (${slug})`)
    return { family: to?.[0] ?? was, was }
  }
  const display = font(fams.display ?? 'Inter')!
  const body = font(fams.body ?? fams.display ?? 'Inter')!
  const mono = font(fams.mono)

  // Slack is in the folder and not in the README: its own description's first sentence.
  const meta = listed.get(slug) ?? { name: slug[0]!.toUpperCase() + slug.slice(1), category: 'Other', blurb: description.split(/(?<=\.)\s/)[0]!.slice(0, 140) }
  entries.push({
    slug,
    name: meta.name,
    category: meta.category,
    blurb: meta.blurb,
    theme: isDark(rgb(canvas)) ? 'dark' : 'light',
    swatches,
    tokens,
    radius: { sm, md, lg },
    fonts: { display, body, ...(mono && { mono }) },
  })
}
if (unmapped.size) throw new Error(`no Google Fonts stand-in for: ${[...unmapped].join(', ')} — add them to FONTS`)

// Every family, and each weight of it, asked for at Google: 200 or 400.
const families = [...new Set(entries.flatMap((e) => Object.values(e.fonts).map((f) => f!.family)))].sort()
const google: Record<string, { generic: Generic; weights: number[] }> = {}
const generic = Object.fromEntries(Object.values(FONTS).map(([f, g]) => [f, g]))
for (const family of families) {
  const weights: number[] = []
  for (const w of WEIGHTS) {
    const url = `https://fonts.googleapis.com/css2?family=${family.replaceAll(' ', '+')}:wght@${w}&display=swap`
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' } })
    if (res.ok) weights.push(w)
  }
  if (!weights.length) throw new Error(`Google Fonts has no family "${family}"`)
  google[family] = { generic: generic[family]!, weights }
}

await cp(join(clone, 'LICENSE'), join(OUT, 'LICENSE'))
const commit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: clone }).stdout.toString().trim()
await Bun.write(
  join(OUT, 'catalog.json'),
  JSON.stringify({ source: 'https://github.com/VoltAgent/awesome-design-md', commit, google, entries }, null, 1) + '\n',
)
console.log(`${entries.length} entries (${entries.filter((e) => e.theme === 'dark').length} dark), ${families.length} Google families, ${skipped.length} skipped:`)
for (const s of skipped) console.log(`  ${s}`)
