import { readdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { getBrowser, slot } from './pilot'

/**
 * A picture of a running preview, taken in the one browser pilot.ts drives: its own chromium on the dev server,
 * or the browser container's over CDP on the cluster, where a chromium spawned
 * here would run the model's page beside apps-builder's token and keys.
 */

/** The ceiling on loading the page to photograph. */
const TIMEOUT_MS = 30_000
/** How long a loaded page gets to finish its fetches before the picture is taken anyway. */
const IDLE_MS = 8_000

/**
 * Prefer the headless shell: the full `chromium-*` build needs libcups, which the dev server does
 * not have. Returns undefined rather than throwing when playwright's cache is absent —
 * a box with no chromium still has to serve the app, it just serves it without pictures.
 */
export function chromePath(): string | undefined {
  const root = join(process.env.HOME ?? '', '.cache/ms-playwright')
  let dirs: string[]
  try {
    dirs = readdirSync(root).sort()
  } catch {
    return undefined
  }
  const latest = (prefix: string) => dirs.filter((d) => d.startsWith(prefix)).at(-1)
  const shell = latest('chromium_headless_shell-')
  if (shell) return join(root, shell, 'chrome-headless-shell-linux64/chrome-headless-shell')
  const full = latest('chromium-')
  return full ? join(root, full, 'chrome-linux64/chrome') : undefined
}

/**
 * Photograph `url` into `out`. Returns whether a file was written.
 *
 * The page is laid out at 1280×800 — a desktop breakpoint, and the 16:10 the gallery card
 * is cut to — but rastered at three quarters of that. 960×600 still covers a ~355 px card
 * on a retina screen with room to spare, and the full-resolution PNG of a gradient-heavy
 * app measured 400 KB, which is a lot of bytes for a thumbnail.
 *
 * Never throws. A card with no picture is worth less than whatever asked for the picture,
 * which is the rule checkpoint() already follows.
 */
export async function screenshot(url: string, out: string): Promise<boolean> {
  // A dead port photographs as chromium's own error page, and that would replace a good
  // picture with a screenshot of a browser error. One request settles it first.
  const alive = await fetch(url, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok)
    .catch(() => false)
  if (!alive) return false

  // Written aside and renamed, never straight onto `out`: a failed capture must not be
  // able to truncate the last good picture. In a slot, as check_app's pages are: the browser
  // holds MAX_PAGES at most, however many turns end at once.
  const tmp = `${out}.tmp.png`
  return slot(async () => {
    let context: BrowserContext | undefined
    try {
      // 1280×800 laid out, rastered at three quarters: 960×600, as the CLI's --window-size and
      // --force-device-scale-factor made it. Loaded, then up to IDLE_MS for the network to settle — an app
      // that polls never does, and is photographed anyway. ponytail: where --virtual-time-budget waited for
      // paint; a cold vite still compiling could photograph blank — wait for a selector if seen.
      context = await (await getBrowser()).newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.75 })
      const page = await context.newPage()
      await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT_MS })
      await page.waitForLoadState('networkidle', { timeout: IDLE_MS }).catch(() => {})
      await page.screenshot({ path: tmp, type: 'png' })
      await rename(tmp, out)
      return true
    } catch (e) {
      console.error(`[shot ${url}]`, (e as Error).message)
      return false
    } finally {
      await context?.close().catch(() => {})
      await rm(tmp, { force: true }).catch(() => {})
    }
  })
}
