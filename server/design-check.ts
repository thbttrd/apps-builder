/**
 * The check a design example passes before the person sees it (write_design, design.ts). The
 * model writes the whole page, so this is where the design phase's strength is: the page is
 * rendered in chromium and refused, with what failed, unless its colours and fonts are the
 * tokens it declares — the ones approve() (design.ts) copies into the app's @theme — and it fits
 * a phone and a desktop.
 *
 * It is rendered the way the picker serves it (routes.ts): under CSP, sandboxed, scripts off. So
 * what passes here is what the person sees — a page drawn by a script, or reaching for an
 * image elsewhere, fails here as it would there. The browser and its two-page ceiling are
 * pilot.ts's.
 */
import { coloursIn, contrast, dist, isDark, near, parseHex, toHex } from './colour'
import { MEASURE, type Measured, colourTokens, family_, measureOf } from './design-measure'
import { getBrowser, overflow, slot } from './pilot'

/** An example is one screen. Past this it is a site, and every retry pays for all of it. */
export const MAX_BYTES = 40_000
export const COLOURS = ['canvas', 'surface', 'ink', 'ink-muted', 'primary', 'on-primary', 'hairline'] as const
/** Every token an example declares on :root, under Tailwind 4's names: approve() makes them the app's @theme. */
export const REQUIRED = [
  ...COLOURS.map((c) => `--color-${c}`),
  '--font-display',
  '--font-body',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
]
/** The seven, --color-accent, and a few of the example's own: danger, success… */
const MAX_COLOURS = 12

/** What the example's route sends (routes.ts), and so what the check renders under. */
export const CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; " +
  'font-src https://fonts.gstatic.com; img-src data:'

const WIDTHS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } } as const
/** The page's own address in the check. Nothing is served there: the route answers it. */
const DOC = 'http://design.check/example.html'
/** Reasons past this are counted, not listed: the model fixes the first ones and sends again. */
const REASONS_MAX = 8
const LOAD_MS = 15_000
/** A pass, both widths, is about 1 s. Past this the context is closed and the check refuses. */
const PASS_MS = 45_000
/** How long the fonts may take; past it the font rule says which did not load. */
const FONTS_MS = 5_000

export type Theme = 'light' | 'dark' | 'both' | null
export type CheckOptions = {
  /** The project's name, which the page shows. Empty: not checked. */
  app: string
  /** The brief's: the canvas must be light, dark, or light with a dark palette for the device. */
  theme: Theme
  /** The examples already passed: this one must not be one of them in another name. */
  others: { id: string; tokens: Record<string, string> }[]
}
export type Checked = {
  /** Empty when it passes. */
  reasons: string[]
  /** What was not checked, and why — said to the model, never a refusal. */
  notes: string[]
  /** Its :root tokens as declared: `--color-canvas` → `#faf9f5`, fonts and radii as written. */
  tokens: Record<string, string>
  /** The colour tokens under prefers-color-scheme: dark, for a 'both' brief. */
  dark?: Record<string, string>
  /** JPEGs at half scale: desktop, phone, and desktop-dark and phone-dark for a 'both' brief. */
  shots: Record<string, Uint8Array>
  /** What the page is made of at 1280, for DESIGN.md's front matter; absent if it could not be read. */
  measured?: Measured
}

/**
 * Check one example. Never throws, and never passes a page it could not open: a check that
 * did not run is a refusal saying so, with whatever it found before it stopped. It passed
 * such a page once, with no tokens, and approve() then wrote an empty @theme (review, #31).
 */
export async function checkDesign(html: string, opts: CheckOptions): Promise<Checked> {
  const reasons = staticReasons(html)
  const out: Checked = { reasons, notes: [], tokens: {}, shots: {} }
  if (Buffer.byteLength(html) > MAX_BYTES * 2) return out
  try {
    await slot(() => render(html, opts, out))
  } catch (e) {
    out.reasons.push(`the check could not open it (${(e as Error).message.split('\n')[0]}): send it again`)
  }
  if (out.reasons.length > REASONS_MAX) {
    const n = out.reasons.length - REASONS_MAX
    out.reasons = [...out.reasons.slice(0, REASONS_MAX), `…and ${n} more`]
  }
  return out
}

/** What is wrong with the file before it is opened. */
function staticReasons(html: string): string[] {
  const out: string[] = []
  const bytes = Buffer.byteLength(html)
  if (bytes > MAX_BYTES) out.push(`it is ${Math.round(bytes / 1000)} KB; an example is one screen, at most ${MAX_BYTES / 1000} KB`)
  if (!/^\s*(<!--[\s\S]*?-->\s*)*<!doctype html>/i.test(html)) out.push('it does not start with <!doctype html>: send the whole page')
  if (!/<head[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) out.push('it has no <head> or no <body>: send the whole page')
  if (/<script[\s/>]/i.test(html)) out.push('it has a <script>: examples are shown with scripts off, so draw everything in HTML and CSS')
  if (/<(iframe|object|embed)[\s>]/i.test(html)) out.push('it embeds another page (<iframe>, <object> or <embed>): draw it instead')
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) out.push('it has a <meta http-equiv="refresh">: an example stays on its page')
  return out
}

/** One colour on the page, as the browser computed it, and where. */
type Paint = { prop: string; value: string; el: string }
export type Audit = {
  /** Every custom property declared on :root or html, by name, as computed. */
  vars: Record<string, string>
  paints: Paint[]
  /** Text elements' computed font-family, and where. */
  fonts: { family: string; el: string }[]
  /** Families with a FontFace in document.fonts, and whether one of them loaded. */
  faces: Record<string, boolean>
  background: string
  text: string
  wide: string
}

async function render(html: string, opts: CheckOptions, out: Checked): Promise<void> {
  const schemes = opts.theme === 'both' ? (['light', 'dark'] as const) : (['light'] as const)
  const reasons = new Set<string>()
  // A font token's that did not load: dropped when Google Fonts could not be reached at all.
  const unloaded = new Set<string>()
  const offline = { fonts: false }
  const refused = new Set<string>()
  const google400 = new Set<string>()
  try {
    for (const scheme of schemes) {
      const context = await (await getBrowser()).newContext({
        javaScriptEnabled: false,
        colorScheme: scheme,
        viewport: WIDTHS.desktop,
        deviceScaleFactor: 0.5,
      })
      // Nothing in a pass has a timeout of its own that always fires (evaluate has none), and a
      // font request that stalled held the browser slot, shared with check_app, for good.
      let late = false
      const deadline = setTimeout(() => {
        late = true
        void context.close().catch(() => {})
      }, PASS_MS)
      try {
        const page = await context.newPage()
        await page.route(DOC, (r) =>
          r.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP }, body: html }),
        )
        page.on('requestfailed', (r) => {
          const url = r.url()
          const why = r.failure()?.errorText ?? ''
          if (url.startsWith('data:')) return
          if (/csp|blocked/i.test(why)) refused.add(url.slice(0, 120))
          else if (/fonts\.(googleapis|gstatic)\.com/.test(url)) offline.fonts = true
        })
        page.on('response', (r) => {
          if (r.status() === 400 && r.url().startsWith('https://fonts.googleapis.com/')) {
            for (const f of new URL(r.url()).searchParams.getAll('family')) google400.add(f)
          }
        })
        await page.goto(DOC, { waitUntil: 'load', timeout: LOAD_MS })
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
        // Waited for here, not in the page: with scripts off, a timer in it never fires.
        await Promise.race([page.evaluate(() => document.fonts.ready.then(() => true)), Bun.sleep(FONTS_MS)])
        for (const [width, size] of Object.entries(WIDTHS) as [keyof typeof WIDTHS, (typeof WIDTHS)[keyof typeof WIDTHS]][]) {
          await page.setViewportSize(size)
          const audit = { ...(await page.evaluate(AUDIT)), wide: await page.evaluate(overflow) }
          if (width === 'desktop' && scheme === 'light') declared(audit, opts, reasons)
          judge(audit, scheme, width, opts, reasons, unloaded)
          if (width === 'desktop' && scheme === 'light') {
            out.tokens = Object.fromEntries(Object.entries(audit.vars).filter(([k]) => /^--(color|font|radius)-/.test(k)))
            // A reading, never a reason: a page it cannot read still passes, with less front matter.
            out.measured = await page
              .evaluate(MEASURE)
              .then((raw) => measureOf(raw, audit.vars))
              .catch((e: Error) => void console.error('[design-check] could not measure the page:', e.message))
          }
          if (width === 'desktop' && scheme === 'dark') {
            out.dark = Object.fromEntries(Object.entries(audit.vars).filter(([k, v]) => k.startsWith('--color-') && out.tokens[k] !== v))
          }
          out.shots[scheme === 'dark' ? `${width}-dark` : width] = await page.screenshot({ type: 'jpeg', quality: 75, timeout: 10_000 })
        }
      } catch (e) {
        throw late ? new Error(`it took over ${PASS_MS / 1000} s`) : e
      } finally {
        clearTimeout(deadline)
        await context.close().catch(() => {})
      }
    }
  } finally {
    report(out, reasons, unloaded, refused, google400, offline)
  }
}

/** What render found, into `out`: what failed to load, then the rest. Also when a pass threw. */
function report(
  out: Checked,
  reasons: Set<string>,
  unloaded: Set<string>,
  refused: Set<string>,
  google400: Set<string>,
  offline: { fonts: boolean },
): void {
  // What failed to load goes first: a missing font or stylesheet is the cause of half the rest.
  const loads: string[] = []
  for (const u of refused) {
    loads.push(`it loads ${u}, which is refused: only Google Fonts may come from outside — draw images as inline <svg> or CSS`)
  }
  // Google answers 400 only for a request whose every family is unknown; a mixed one drops the
  // unknown quietly, and the font rule in judge() catches a token font that did not come.
  for (const f of google400) {
    loads.push(`fonts.googleapis.com has no family or weight "${f}": use the Google Fonts families and weights the note gives`)
  }
  if (offline.fonts) out.notes.push('Google Fonts could not be reached from here, so whether the fonts load was not checked')
  out.reasons.push(...loads, ...(offline.fonts ? [] : unloaded), ...reasons)
}

/**
 * Runs in the page (scripts off: the check's evaluate is not the page's). Reads what the
 * browser drew: the :root tokens, every colour it painted, every text's font.
 */
export async function AUDIT(): Promise<Audit> {
  const root = document.documentElement
  const names = new Set<string>()
  const walk = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule && /(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) {
        for (const p of rule.style) if (p.startsWith('--')) names.add(p)
      }
      if ('cssRules' in rule && rule.cssRules) walk(rule.cssRules as CSSRuleList)
    }
  }
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules)
    } catch {
      // Google's stylesheet is another origin's: its rules are not ours to read, nor ours.
    }
  }
  const rootStyle = getComputedStyle(root)
  const vars = Object.fromEntries([...names].map((n) => [n, rootStyle.getPropertyValue(n).trim()]))

  const label = (el: Element) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
    return `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls.map((c) => `.${c}`).join('')}>${text ? ` "${text}"` : ''}`
  }
  const paints: Paint[] = []
  const fonts: { family: string; el: string }[] = []
  const add = (prop: string, value: string, el: Element) => {
    if (value && value !== 'none' && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') paints.push({ prop, value, el: label(el) })
  }
  const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse', 'text', 'tspan', 'use'])
  const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'])
  const boxed = (s: CSSStyleDeclaration, el: Element, drawn = true) => {
    if (drawn) add('background-color', s.backgroundColor, el)
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const w = parseFloat(s.getPropertyValue(`border-${side}-width`))
      const style = s.getPropertyValue(`border-${side}-style`)
      if (w > 0 && style !== 'none' && style !== 'hidden') add(`border-${side}-color`, s.getPropertyValue(`border-${side}-color`), el)
    }
    // Not `auto`: the browser's own focus ring, on a field a check_app step left focused.
    if (s.outlineStyle !== 'none' && s.outlineStyle !== 'auto' && parseFloat(s.outlineWidth) > 0) add('outline-color', s.outlineColor, el)
    if (s.boxShadow !== 'none') add('box-shadow', s.boxShadow, el)
    if (s.backgroundImage !== 'none') add('background-image', s.backgroundImage.replace(/url\([^)]*\)/g, ''), el)
  }
  // A gradient's stops sit in <defs>, which draws nothing itself: read whether or not they show.
  for (const stop of document.querySelectorAll('stop')) add('stop-color', getComputedStyle(stop).stopColor, stop)
  for (const el of [root, ...document.body.querySelectorAll('*'), document.body]) {
    if (el !== root && el !== document.body && !el.checkVisibility({ visibilityProperty: true })) continue
    const s = getComputedStyle(el)
    const tag = el.tagName.toLowerCase()
    if (el instanceof SVGElement) {
      if (SHAPES.has(tag)) {
        if (!s.fill.startsWith('url(')) add('fill', s.fill, el)
        if (!s.stroke.startsWith('url(')) add('stroke', s.stroke, el)
      }
      continue
    }
    // A range the browser draws computes a white background and a grey colour it never paints
    // (Chromium's own sheet): refused as off-token for five catalog designs (review, #31).
    const own = el instanceof HTMLInputElement && el.type === 'range' && s.appearance !== 'none'
    boxed(s, el, !own)
    const texty = !own && (FIELDS.has(el.tagName) || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
    if (texty) {
      add('color', s.color, el)
      fonts.push({ family: s.fontFamily, el: label(el) })
      if (s.textDecorationLine !== 'none') add('text-decoration-color', s.textDecorationColor, el)
      if (s.textShadow !== 'none') add('text-shadow', s.textShadow, el)
    }
    // What the browser draws in the accent colour: its own blue when auto.
    if (((el instanceof HTMLInputElement && ['checkbox', 'radio', 'range'].includes(el.type)) || el instanceof HTMLProgressElement) && s.appearance !== 'none') {
      if (s.accentColor === 'auto') paints.push({ prop: 'accent-color', value: 'auto', el: label(el) })
      else add('accent-color', s.accentColor, el)
    }
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder) {
      add('::placeholder color', getComputedStyle(el, '::placeholder').color, el)
    }
    for (const pseudo of ['::before', '::after']) {
      const p = getComputedStyle(el, pseudo)
      if (p.content === 'none' || p.content === 'normal') continue
      boxed(p, el)
      if (p.content !== '""' && p.content !== "''") add(`${pseudo} color`, p.color, el)
    }
  }
  const faces: Record<string, boolean> = {}
  for (const f of document.fonts) {
    const family = f.family.replace(/^["']|["']$/g, '')
    faces[family] = faces[family] || f.status === 'loaded'
  }
  const bg = (el: Element) => getComputedStyle(el).backgroundColor
  const background = bg(root) !== 'rgba(0, 0, 0, 0)' ? bg(root) : bg(document.body)
  // pilot's overflow() is a second evaluate: evaluate serialises this function alone.
  return { vars, paints, fonts, faces, background, text: document.body.innerText, wide: '' }
}

/**
 * What the page declares, read once, at 1280 in light: the tokens it must have and their form,
 * the app's name and real content, and that it is not another example in a new name.
 */
function declared(audit: Audit, opts: CheckOptions, reasons: Set<string>): void {
  const { vars } = audit
  const missing = REQUIRED.filter((n) => !vars[n])
  if (missing.length) reasons.add(`:root does not declare ${missing.join(', ')}`)
  const notHex = Object.entries(vars).filter(([k, v]) => k.startsWith('--color-') && !parseHex(v))
  if (notHex.length) reasons.add(`colour tokens must be #rrggbb hex: ${notHex.map(([k, v]) => `${k}: ${v}`).join('; ')}`)
  const colours = Object.keys(vars).filter((k) => k.startsWith('--color-'))
  if (colours.length > MAX_COLOURS) reasons.add(`it declares ${colours.length} colour tokens; at most ${MAX_COLOURS}`)

  const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  if (opts.app && !words(audit.text).includes(words(opts.app))) reasons.add(`the app's name, "${opts.app}", is not on the page`)
  if (/lorem ipsum/i.test(audit.text)) reasons.add('it has lorem ipsum: write the real content the app would show')
  const tokens = colourTokens(vars)
  const canvas = tokens.find((t) => t.name === 'canvas')?.rgb
  const primary = tokens.find((t) => t.name === 'primary')?.rgb
  for (const o of opts.others) {
    const oc = parseHex(o.tokens['--color-canvas'] ?? '')
    const op = parseHex(o.tokens['--color-primary'] ?? '')
    if (canvas && primary && oc && op && near(canvas, oc) && near(primary, op)) {
      reasons.add(`it has the canvas and primary of design ${o.id}: each example is its own design — use the palette the note gives it`)
    }
  }
}

/**
 * What the page paints and sets off the tokens in `vars`, as reasons: every colour (at any alpha; a shadow
 * may also be black), and every text's font. The examples' check (judge) and check_app's OFF-DESIGN, which
 * passes the approved app's @theme (themeOf).
 */
export function offTokens(audit: Audit, vars: Record<string, string>, where = ''): string[] {
  const out: string[] = []
  const tokens = colourTokens(vars)
  // Every colour painted is a token, at any alpha. A shadow may also be black at alpha.
  const off = new Map<string, { n: number; props: Set<string>; el: string; hint: string }>()
  for (const p of audit.paints) {
    if (p.prop === 'accent-color' && p.value === 'auto') {
      out.push(`${p.el} is drawn by the browser in its own colour: set accent-color: var(--color-primary)`)
      continue
    }
    for (const c of coloursIn(p.value)) {
      if (!c.rgb) {
        record(off, c.text, p, 'write colours as var(--color-…) tokens')
        continue
      }
      if (c.rgb.a === 0 || tokens.some((t) => near(t.rgb, c.rgb!))) continue
      if (p.prop.endsWith('shadow') && near(c.rgb, { r: 0, g: 0, b: 0, a: 1 })) continue
      const nearest = [...tokens].sort((x, y) => dist(x.rgb, c.rgb!) - dist(y.rgb, c.rgb!))[0]
      record(off, toHex(c.rgb) + (c.rgb.a < 1 ? ` at ${Math.round(c.rgb.a * 100)}%` : ''), p, nearest ? `nearest token --color-${nearest.name} ${toHex(nearest.rgb)}` : '')
    }
  }
  const list = [...off].sort((a, b) => b[1].n - a[1].n)
  for (const [value, o] of list.slice(0, 4)) {
    out.push(
      `${value}${where} is not a token: ${[...o.props].join(', ')} of ${o.n} element${o.n > 1 ? 's' : ''}, e.g. ${o.el}` +
        (o.hint ? ` (${o.hint})` : '') +
        (o.el.startsWith('<button') || o.el.startsWith('<input') || o.el.startsWith('<a')
          ? " — style buttons, inputs and links yourself: the browser's own colours are not tokens"
          : ''),
    )
  }
  if (list.length > 4) out.push(`…and ${list.length - 4} more colours${where} that are not tokens`)

  // Every text in a font token.
  const allowed = ['--font-display', '--font-body', '--font-mono'].map((n) => vars[n]).filter((v): v is string => !!v)
  const ok = new Set(allowed.map(family_))
  const strays = new Map<string, { n: number; el: string }>()
  for (const f of audit.fonts) {
    if (ok.has(family_(f.family))) continue
    const s = strays.get(f.family) ?? { n: 0, el: f.el }
    s.n++
    strays.set(f.family, s)
  }
  for (const [family, s] of [...strays].slice(0, 3)) {
    out.push(
      `${s.n} text element${s.n > 1 ? 's are' : ' is'} set in ${family}, e.g. ${s.el}, not in var(--font-display), var(--font-body) or var(--font-mono)` +
        (/^<(button|input|select|textarea)/.test(s.el) ? ' — buttons and inputs do not inherit the font: give them font: inherit' : ''),
    )
  }
  return out
}

/** The page's audit at one width in one scheme, as reasons; a font token's that did not load, into `unloaded`. */
function judge(
  audit: Audit,
  scheme: 'light' | 'dark',
  width: keyof typeof WIDTHS,
  opts: CheckOptions,
  reasons: Set<string>,
  unloaded: Set<string>,
): void {
  const at = width === 'phone' ? '390px' : '1280px'
  const { vars } = audit
  const tokens = colourTokens(vars)
  const token = (n: string) => tokens.find((t) => t.name === n)?.rgb
  const where = scheme === 'dark' ? ' in the dark palette' : ''

  for (const r of offTokens(audit, vars, where)) reasons.add(r)

  // Each font token's first family loaded from Google.
  // Mono is optional, and a screen may have no code on it: only the two that every example uses.
  for (const n of ['--font-display', '--font-body']) {
    const first = vars[n]?.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
    if (!first) continue
    if (!(first in audit.faces)) unloaded.add(`${n}'s font "${first}" is not loaded from Google Fonts: put it in the <link>`)
    else if (!audit.faces[first]) unloaded.add(`${n}'s font "${first}" did not load: no text uses it, or Google has no such weight`)
  }

  // The canvas: the page's background, the brief's theme, and what reads on it.
  const canvas = token('canvas')
  const bg = coloursIn(audit.background)[0]?.rgb
  if (bg && bg.a < 1) reasons.add(`the page sets no background${where}: set background: var(--color-canvas) on html or body`)
  else if (canvas && bg && !near(canvas, bg)) reasons.add(`the page's background${where} is ${toHex(bg)}, not --color-canvas ${toHex(canvas)}: set it on html or body`)
  if (canvas) {
    const want = opts.theme === 'both' ? scheme : opts.theme
    if (want === 'light' && isDark(canvas)) reasons.add(`--color-canvas ${toHex(canvas)} is dark, and the brief asks for a light app`)
    if (want === 'dark' && !isDark(canvas)) {
      reasons.add(
        opts.theme === 'both'
          ? `under prefers-color-scheme: dark --color-canvas is still ${toHex(canvas)}: declare the dark palette in @media (prefers-color-scheme: dark) { :root { … } }, same names`
          : `--color-canvas ${toHex(canvas)} is light, and the brief asks for a dark app`,
      )
    }
    for (const [a, b, min] of [['ink', 'canvas', 4.5], ['ink', 'surface', 4.5], ['ink-muted', 'canvas', 3], ['on-primary', 'primary', 3]] as const) {
      const x = token(a)
      const y = token(b)
      if (x && y && contrast(x, y) < min) {
        reasons.add(`--color-${a} on --color-${b}${where} is ${contrast(x, y).toFixed(2)}:1; it needs ${min}:1`)
      }
    }
  }

  if (audit.wide) reasons.add(`at ${at}: ${audit.wide.replace(/\n/g, ' ')}`)
}

function record(off: Map<string, { n: number; props: Set<string>; el: string; hint: string }>, value: string, p: Paint, hint: string) {
  const o = off.get(value) ?? { n: 0, props: new Set<string>(), el: p.el, hint }
  o.n++
  o.props.add(p.prop)
  off.set(value, o)
}
