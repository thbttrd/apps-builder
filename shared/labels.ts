/**
 * What a chat row prints after the tool's name. Shared by the server, which sends it live,
 * and the client, which rebuilds the rows from stored history on reload — one definition,
 * so a reloaded row cannot read differently from the live one. No imports: the client
 * bundle pulls this file in whole.
 *
 * A check_app row carries its viewport, step count and whether it asked for a look —
 * `/ · mobile · 3 steps · look` — which is the difference between "it loaded" and "it used
 * the page on a phone and looked at it". An update_plan row carries how far the plan has got,
 * and a write_design row its example and name: `B · Soft paper`; an add_service row, the service.
 */
export function toolDetail(name: string, input: unknown): string | undefined {
  const i = (input ?? {}) as { path?: unknown; viewport?: unknown; steps?: unknown; look?: unknown; id?: unknown; name?: unknown; service?: unknown }
  switch (name) {
    case 'add_service':
      return typeof i.service === 'string' ? i.service : undefined
    case 'write_design':
      return typeof i.id !== 'string' ? undefined : typeof i.name === 'string' && i.name ? `${i.id} · ${i.name}` : i.id
    case 'update_plan':
      return Array.isArray(i.steps) ? `${i.steps.filter((s: { status?: unknown } | null) => s?.status === 'done').length}/${i.steps.length} done` : undefined
    case 'check_app': {
      if (typeof i.path !== 'string') return undefined
      const n = Array.isArray(i.steps) ? i.steps.length : 0
      return [
        i.path,
        typeof i.viewport === 'string' && i.viewport !== 'desktop' ? i.viewport : '',
        n ? `${n} step${n > 1 ? 's' : ''}` : '',
        typeof i.look === 'string' && i.look ? 'look' : '',
      ]
        .filter(Boolean)
        .join(' · ')
    }
    default:
      return typeof i.path === 'string' ? i.path : undefined
  }
}
