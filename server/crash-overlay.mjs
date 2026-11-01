// @ts-check
/**
 * A crashed app is painted, not left white. A React render crash unmounts the whole root and vite shows
 * nothing (its overlay is for transform errors), so the preview pane and the gallery picture were a blank
 * rectangle. The script this puts first in every app's page (preview-vite.mjs, whatever the project's own
 * vite.config.ts says) waits for an uncaught error or rejection and, if `#root` is then empty, shows the
 * error in a `<pre id="ab-crash">` beside it: outside the root, so check_app's APP CRASHED rule still holds.
 * It goes again once the root renders (React Refresh remounts a failed root when the code is fixed). ASCII
 * only: a page without a charset would garble anything else.
 */
const SCRIPT = `(() => {
  const paint = (what) => setTimeout(() => {
    const root = document.getElementById('root')
    if (!root || root.innerHTML.trim() || document.getElementById('ab-crash')) return
    const pre = document.createElement('pre')
    pre.id = 'ab-crash'
    pre.textContent = 'The app crashed. The builder sees this error too.\\n\\n' + String(what).split('\\n').slice(0, 6).join('\\n')
    pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;overflow:auto;white-space:pre-wrap;z-index:2147483647;' +
      'background:#fff5f5;color:#9b1c1c;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace'
    document.body.append(pre)
    new MutationObserver((_, seen) => {
      if (root.innerHTML.trim()) (pre.remove(), seen.disconnect())
    }).observe(root, { childList: true })
  }, 50)
  addEventListener('error', (e) => paint(e.error?.stack || e.message))
  addEventListener('unhandledrejection', (e) => paint(e.reason?.stack || e.reason))
})()`

export function crashOverlay() {
  return {
    name: 'apps-builder:crash-overlay',
    transformIndexHtml: () => [{ tag: 'script', children: SCRIPT, injectTo: /** @type {const} */ ('head-prepend') }],
  }
}
