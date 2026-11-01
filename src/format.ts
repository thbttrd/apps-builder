/**
 * "3h ago". Both the project cards and the snapshot timeline are ordered by recency, so
 * the unit carries the meaning and a minute of precision would be noise.
 */
export function ago(iso?: string): string {
  const secs = (Date.now() - Date.parse(iso ?? '')) / 1000
  if (!Number.isFinite(secs) || secs < 90) return 'just now'
  const [n, unit] =
    secs < 3600 ? [secs / 60, 'm'] : secs < 86_400 ? [secs / 3600, 'h'] : [secs / 86_400, 'd']
  return `${Math.round(n)}${unit} ago`
}
