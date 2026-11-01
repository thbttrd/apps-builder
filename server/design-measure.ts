/**
 * What a design example's page is made of, measured in the browser: MEASURE runs in the page,
 * and measureOf names what it found — the text styles, the parts (buttons, input, card, header),
 * the spacing and the radii — for DESIGN.md's front matter (design-doc.ts) and the check.
 */
import { type Rgba, coloursIn, near, parseHex, toHex } from './colour'

/**
 * One text style the page draws, and how much text is in it: which font token, the size in px,
 * the weight, the line height as a ratio (null for `normal`), the tracking in px, upper case.
 */
export type TextStyle = { font: 'display' | 'body' | 'mono'; size: number; weight: number; lineHeight: number | null; tracking: number; upper: boolean; chars: number }
/**
 * One component as the page draws it: colours as `{colors.<token>}` (or `transparent`), a
 * radius as `{rounded.<token>}` or px, padding as CSS writes it, and its text style, as an
 * index into `styles`.
 */
export type Part = {
  backgroundColor?: string
  textColor?: string
  border?: string
  borderBottom?: string
  rounded?: string
  padding?: string
  height?: number
  style?: number
}
const PARTS = ['button-primary', 'button-secondary', 'input', 'card', 'header'] as const
export type Measured = {
  /** The eight styles with the most text, most first. */
  styles: TextStyle[]
  /** Which of them is the page's own, as <body> sets it, if it is one. */
  body?: number
  /** The six paddings and gaps used most, smallest first, in px. */
  spacing: number[]
  /** Whether anything is drawn as a pill or a circle. */
  pill: boolean
  /** The most common of each, where the page has one. */
  parts: Partial<Record<(typeof PARTS)[number], Part>>
}

/** A text style as the browser computed it, before it is named. */
type RawText = { family: string; size: number; weight: number; lineHeight: string; tracking: string; upper: boolean }
type RawPart = {
  kind: 'button' | 'field' | 'box' | 'header'
  bg: string
  color: string
  /** Top, right, bottom, left: "width|colour" where one is drawn, else "". */
  borders: string[]
  radius: string
  padding: number[]
  height: number
  text: RawText
}
type RawMeasure = { base: RawText; texts: (RawText & { chars: number })[]; spaces: number[]; radii: string[]; parts: RawPart[] }

/**
 * Runs in the page, after AUDIT, at 1280 in light: what the page is made of, as the browser drew
 * it — each text's style and how much text is in it, the paddings and gaps, the radii, and the
 * buttons, fields, boxes and header. Named and counted in measureOf, outside the page.
 */
export function MEASURE(): RawMeasure {
  const FIELD =
    'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=submit]):not([type=button]):not([type=hidden]), textarea, select'
  const BUTTON = 'button, [role=button], input[type=submit], input[type=button], a'
  const SIDES = ['top', 'right', 'bottom', 'left']
  const NONE = 'rgba(0, 0, 0, 0)'
  const textOf = (s: CSSStyleDeclaration): RawText => ({
    family: s.fontFamily,
    size: parseFloat(s.fontSize),
    weight: Number(s.fontWeight) || 400,
    lineHeight: s.lineHeight,
    tracking: s.letterSpacing,
    upper: s.textTransform === 'uppercase',
  })
  const body = getComputedStyle(document.body).backgroundColor
  const page = body !== NONE ? body : getComputedStyle(document.documentElement).backgroundColor
  const out: RawMeasure = { base: textOf(getComputedStyle(document.body)), texts: [], spaces: [], radii: [], parts: [] }
  for (const el of document.body.querySelectorAll('*')) {
    if (el instanceof SVGElement || !el.checkVisibility({ visibilityProperty: true })) continue
    const s = getComputedStyle(el)
    const field = el.matches(FIELD)
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent?.trim() ?? '').join('').length
    const typed = field ? ((el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || '').length : 0
    if (own + typed) out.texts.push({ ...textOf(s), chars: own + typed })
    const pads = SIDES.map((side) => parseFloat(s.getPropertyValue(`padding-${side}`)) || 0)
    const gaps = [s.rowGap, s.columnGap].map((g) => parseFloat(g) || 0)
    for (const v of new Set([...pads, ...gaps])) if (v >= 2) out.spaces.push(v)
    if (s.borderTopLeftRadius !== '0px') out.radii.push(s.borderTopLeftRadius)
    const borders = SIDES.map((side) => {
      const w = parseFloat(s.getPropertyValue(`border-${side}-width`))
      const style = s.getPropertyValue(`border-${side}-style`)
      return w > 0 && style !== 'none' && style !== 'hidden' ? `${w}|${s.getPropertyValue(`border-${side}-color`)}` : ''
    })
    const painted = s.backgroundColor !== NONE
    // A card, a panel, a row that stands out: padded, wide enough to hold something, with text,
    // and set off from the page by its own background or a border all round.
    const boxy =
      Math.min(...pads) >= 8 && Math.max(...pads) >= 12 && el.getBoundingClientRect().width >= 120 &&
      !!el.textContent?.trim() && ((painted && s.backgroundColor !== page) || borders.every(Boolean))
    const kind: RawPart['kind'] | null = field
      ? 'field'
      : el.matches(BUTTON) && (el.tagName !== 'A' || painted)
        ? 'button'
        : el.tagName === 'HEADER'
          ? 'header'
          : boxy
            ? 'box'
            : null
    if (kind) {
      out.parts.push({
        kind,
        bg: s.backgroundColor,
        color: s.color,
        borders,
        radius: s.borderTopLeftRadius,
        padding: pads,
        height: Math.round(el.getBoundingClientRect().height),
        text: textOf(s),
      })
    }
  }
  return out
}

/**
 * The page's reading, named: colours by the token they are (±2 a channel, as the check matches
 * them; the first in :root's order when two are the same colour), fonts by their token, radii
 * by theirs. Each component is the most common of its kind: the primary button is the one on
 * --color-primary, the secondary the most common other one.
 */
export function measureOf(raw: RawMeasure, vars: Record<string, string>): Measured {
  const tokens = colourTokens(vars)
  // `role` first when it is that colour: a primary that is the ink read as {colors.ink}, and
  // 24 of the 61 designs' primary buttons were not found (review, #32).
  const colour = (value: string, role?: string): string | undefined => {
    const c = coloursIn(value)[0]?.rgb
    if (!c) return undefined
    if (c.a === 0) return 'transparent'
    const t = tokens.find((x) => x.name === role && near(x.rgb, c)) ?? tokens.find((x) => near(x.rgb, c))
    const alpha = c.a < 0.95 ? ` at ${Math.round(c.a * 100)}%` : ''
    return t ? `{colors.${t.name}}${alpha}` : toHex(c) + alpha
  }
  // The body's first: where display and body are one font (40 of the 61), its text is the body's.
  const fontOf = (family: string): TextStyle['font'] | undefined =>
    (['body', 'display', 'mono'] as const).find((f) => vars[`--font-${f}`] && family_(vars[`--font-${f}`]!) === family_(family))
  const px = (v: string) => (v.endsWith('rem') ? parseFloat(v) * 16 : parseFloat(v))
  const radius = (v: string): string | undefined => {
    if (!v || v === '0px') return undefined
    if (v.endsWith('%') ? parseFloat(v) >= 50 : px(v) >= 999) return '{rounded.full}'
    const t = (['sm', 'md', 'lg'] as const).find((r) => vars[`--radius-${r}`] && Math.abs(px(vars[`--radius-${r}`]!) - px(v)) < 0.5)
    return t ? `{rounded.${t}}` : `${Math.round(px(v))}px`
  }
  const round = (n: number, to = 100) => Math.round(n * to) / to

  // The styles: one per font, size, weight, line height, tracking and case, by how much text each carries.
  const keyOf = (t: RawText) => {
    const font = fontOf(t.family)
    if (!font) return undefined
    const lineHeight = t.lineHeight === 'normal' ? null : round(parseFloat(t.lineHeight) / t.size)
    const tracking = t.tracking === 'normal' ? 0 : round(parseFloat(t.tracking))
    return { key: [font, t.size, t.weight, lineHeight, tracking, t.upper].join('|'), style: { font, size: round(t.size), weight: t.weight, lineHeight, tracking, upper: t.upper } }
  }
  const byKey = new Map<string, TextStyle>()
  for (const t of raw.texts) {
    const k = keyOf(t)
    if (!k) continue
    const s = byKey.get(k.key) ?? { ...k.style, chars: 0 }
    s.chars += t.chars
    byKey.set(k.key, s)
  }
  // Eight, by how much text each carries — but each font's largest always, and the page's own:
  // a design's display figure is often six characters ("€52.20"), and it is the design.
  const all = [...byKey].sort((a, b) => b[1].chars - a[1].chars)
  const base = keyOf(raw.base)
  const largest = (['display', 'body', 'mono'] as const).map((f) => all.filter(([, s]) => s.font === f).sort((a, b) => b[1].size - a[1].size)[0]?.[0])
  const must = new Set([base?.key, ...largest].filter(Boolean))
  const ranked = [...all.filter(([k]) => must.has(k)), ...all.filter(([k]) => !must.has(k))].slice(0, 8).sort((a, b) => b[1].chars - a[1].chars)
  const styles = ranked.map(([, s]) => s)
  const styleOf = (t: RawText) => {
    const k = keyOf(t)?.key
    const i = ranked.findIndex(([key]) => key === k)
    return i < 0 ? undefined : i
  }
  // The page's running text: <body>'s own style, or when no text is set in exactly that, the
  // body-font style nearest its size that is not upper case.
  const closest = base && styles.map((s, i) => [s, i] as const).filter(([s]) => s.font === 'body' && !s.upper)
    .sort(([a], [b]) => Math.abs(a.size - base.style.size) - Math.abs(b.size - base.style.size) || b.chars - a.chars)[0]?.[1]
  const body = styleOf(raw.base) ?? closest

  const counts = new Map<number, number>()
  for (const v of raw.spaces) counts.set(round(v, 1), (counts.get(round(v, 1)) ?? 0) + 1)
  const spacing = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 6)
    .map(([v]) => v)
    .sort((a, b) => a - b)

  const padding = (p: number[]) => {
    const [t, r, b, l] = p.map((v) => (v ? `${round(v, 1)}px` : '0'))
    return t === b && r === l ? (t === r ? t! : `${t} ${r}`) : `${t} ${r} ${b} ${l}`
  }
  const edge = (b: string) => {
    const [w, c] = b.split('|')
    return `${w}px solid ${colour(c ?? '') ?? c}`
  }
  const partOf = (p: RawPart): Part => {
    const bg = colour(p.bg, p.kind === 'button' ? 'primary' : undefined)
    const drawn = p.borders.filter(Boolean)
    const out: Part = {}
    if (bg && (bg !== 'transparent' || p.kind === 'button' || p.kind === 'field')) out.backgroundColor = bg
    if (p.kind === 'button' || p.kind === 'field') out.textColor = colour(p.color, bg === '{colors.primary}' ? 'on-primary' : undefined)
    if (drawn.length === 4 && new Set(drawn).size === 1) out.border = edge(drawn[0]!)
    else if (p.borders[2] && drawn.length === 1) out.borderBottom = edge(p.borders[2])
    out.rounded = radius(p.radius)
    if (p.kind !== 'header') out.padding = padding(p.padding)
    if (p.kind !== 'box') out.height = p.height
    if (p.kind === 'button' || p.kind === 'field') out.style = styleOf(p.text)
    for (const k of Object.keys(out) as (keyof Part)[]) if (out[k] === undefined) delete out[k]
    return out
  }
  /** The most common part among these, as the page draws it. */
  const common = (list: RawPart[]): Part | undefined => {
    const seen = new Map<string, { part: Part; n: number }>()
    for (const p of list) {
      const part = partOf(p)
      const k = JSON.stringify(part)
      seen.set(k, { part, n: (seen.get(k)?.n ?? 0) + 1 })
    }
    return [...seen.values()].sort((a, b) => b.n - a.n)[0]?.part
  }
  const buttons = raw.parts.filter((p) => p.kind === 'button')
  const primary = buttons.filter((p) => colour(p.bg, 'primary') === '{colors.primary}')
  const parts: Measured['parts'] = {
    'button-primary': common(primary),
    'button-secondary': common(buttons.filter((p) => !primary.includes(p))),
    input: common(raw.parts.filter((p) => p.kind === 'field')),
    card: common(raw.parts.filter((p) => p.kind === 'box')),
    header: common(raw.parts.filter((p) => p.kind === 'header')),
  }
  for (const k of PARTS) if (!parts[k]) delete parts[k]
  return { styles, ...(body === undefined ? {} : { body }), spacing, pill: raw.radii.some((r) => radius(r) === '{rounded.full}'), parts }
}

/** A page's colour tokens, as colours: `--color-canvas: #faf9f5` → `{ name: 'canvas', rgb }`. One not in hex is left out. */
export function colourTokens(vars: Record<string, string>): { name: string; rgb: Rgba }[] {
  return Object.entries(vars)
    .filter(([k]) => k.startsWith('--color-'))
    .map(([k, v]) => ({ name: k.slice('--color-'.length), rgb: parseHex(v) }))
    .filter((t): t is { name: string; rgb: Rgba } => !!t.rgb)
}

/** A font-family as compared: each family unquoted and lower case, `"DM Sans", sans-serif` → `dm sans,sans-serif`. */
export const family_ = (f: string) =>
  f
    .split(',')
    .map((x) => x.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .join(',')
