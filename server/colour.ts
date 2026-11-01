/**
 * Colour arithmetic for the design phase: the catalog's tokens (scripts/design-catalog.ts), the
 * examples' check (design-check.ts) and the suite. sRGB only, 0–255 channels, alpha 0–1.
 */
export type Rgba = { r: number; g: number; b: number; a: number }

/** `#rgb`, `#rrggbb` or `#rrggbbaa`, any case; undefined for anything else. */
export function parseHex(v: string): Rgba | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim())
  if (!m) return undefined
  let h = m[1]!.toLowerCase()
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
}

export const toHex = ({ r, g, b }: Rgba) =>
  '#' + [r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')

/** WCAG relative luminance, 0 black to 1 white. The catalog calls a canvas under 0.4 dark. */
function luminance({ r, g, b }: Rgba): number {
  const [R, G, B] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * R! + 0.7152 * G! + 0.0722 * B!
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x! + 0.05) / (y! + 0.05)
}

/** `a` moved `t` of the way to `b`, opaque. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 }
}

export const DARK = 0.4
export const isDark = (c: Rgba) => luminance(c) < DARK

/** The same colour to the eye: within 2 a channel, as the design check matches a token. */
export const near = (a: Rgba, b: Rgba) => Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2

/** Squared distance, for the nearest of several colours. */
export const dist = (a: Rgba, b: Rgba) => (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2

/**
 * The colours in a computed value — a colour, a shadow list, a gradient — each parsed, or
 * `rgb: undefined` for a colour in a space other than sRGB (oklch, lab…), which is no token.
 */
export function coloursIn(value: string): { text: string; rgb?: Rgba }[] {
  const out: { text: string; rgb?: Rgba }[] = []
  for (const m of value.matchAll(/(rgba?|color|oklch|oklab|lab|lch|hsla?|hwb)\([^()]*\)/g)) {
    out.push({ text: m[0], rgb: parseColour(m[0]) })
  }
  return out
}

function parseColour(s: string): Rgba | undefined {
  const alpha = (a: string | undefined) => (a === undefined ? 1 : a.endsWith('%') ? parseFloat(a) / 100 : parseFloat(a))
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: alpha(m[4]) }
  m = /^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (m) return { r: +m[1]! * 255, g: +m[2]! * 255, b: +m[3]! * 255, a: alpha(m[4]) }
  // A token at alpha, as Tailwind's bg-primary/10 writes it — color-mix(in oklab, …) — is
  // computed in oklab, and was refused as no token (review, #31). Lab and lch are not read.
  m = /^(oklab|oklch)\(\s*([\d.e+-]+%?|none)\s+([\d.e+-]+%?|none)\s+([\d.e+-]+%?|none)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s)
  if (!m) return undefined
  const n = (v: string, pct: number) => (v === 'none' ? 0 : v.endsWith('%') ? (parseFloat(v) / 100) * pct : parseFloat(v))
  const L = n(m[2]!, 1)
  let [a, b] = [n(m[3]!, 0.4), n(m[4]!, m[1] === 'oklch' ? 360 : 0.4)]
  if (m[1] === 'oklch') [a, b] = [a * Math.cos((b * Math.PI) / 180), a * Math.sin((b * Math.PI) / 180)]
  return { ...oklabToRgb(L, a, b), a: alpha(m[5]) }
}

/** Björn Ottosson's oklab to sRGB, 0–255 a channel. */
function oklabToRgb(L: number, a: number, b: number): Omit<Rgba, 'a'> {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const out = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return {
    r: out(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: out(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: out(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}
