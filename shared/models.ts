import { EFFORTS, type Effort, KNOBS, type KnobKey, type Thinking, buildEffort } from './params'

/**
 * OpenRouter's model catalog, as the settings panel needs it. Fetched from the browser —
 * the endpoint is public and sends `access-control-allow-origin: *` — once per page load,
 * because it describes what is live (prices, parameters) and would go stale compiled in.
 */
export type Model = {
  id: string
  ctx: number
  /** $ per million tokens; negative for routers, whose price depends on where they route. */
  prompt: number
  completion: number
  image: boolean
  /** Request parameters at least one of its providers honours. */
  supported: Set<string>
  /** The most one reply may be, in tokens, at the provider OpenRouter ranks first; null when
   *  it states none — a router, whose model varies. */
  maxOut: number | null
  /** The model's recommended values; null means it recommends none. */
  defaults: Record<string, number | null>
  reasoning?: {
    mandatory?: boolean
    default_enabled?: boolean
    /** null means every effort; absent means the model offers no choice of effort. */
    supported_efforts?: Effort[] | null
    default_effort?: Effort
  }
}

type Raw = {
  id: string
  context_length: number
  pricing: { prompt: string; completion: string }
  architecture: { input_modalities: string[] }
  supported_parameters?: string[]
  default_parameters?: Record<string, number | null> | null
  reasoning?: Model['reasoning']
  top_provider?: { max_completion_tokens?: number | null } | null
}

let loading: Promise<Model[]> | null = null

/**
 * Tool-capable models only: every turn sends the agent's tools, and OpenRouter drops tools
 * a model cannot take without an error — the agent would answer in prose and edit nothing.
 * `:batch` entries are for offline jobs, not a chat.
 */
export function catalog(): Promise<Model[]> {
  // A deadline, because the server awaits this before a turn is claimed (buildEffortOf).
  loading ??= fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10_000) })
    .then((r) => {
      if (!r.ok) throw new Error(`OpenRouter answered ${r.status}`)
      return r.json() as Promise<{ data: Raw[] }>
    })
    .then(({ data }) =>
      data
        .filter((m) => m.supported_parameters?.includes('tools') && !m.id.endsWith(':batch'))
        .map((m) => ({
          id: m.id,
          ctx: m.context_length,
          prompt: Number(m.pricing.prompt) * 1e6,
          completion: Number(m.pricing.completion) * 1e6,
          image: m.architecture.input_modalities.includes('image'),
          supported: new Set(m.supported_parameters),
          maxOut: m.top_provider?.max_completion_tokens ?? null,
          defaults: m.default_parameters ?? {},
          reasoning: m.reasoning,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    )
    .catch((e) => {
      loading = null // let the next open try again
      throw e
    })
  return loading
}

/** One provider of a model, as /api/v1/models/<id>/endpoints lists it, cut to what is read. */
type Endpoint = {
  max_completion_tokens?: number | null
  context_length?: number
  /** Below 0: degraded or down. */
  status?: number
  supported_parameters?: string[]
}

/**
 * The thinking window: the most one reply may be, reasoning included — the largest any
 * provider of the model allows while leaving half its context for the conversation. Sent as
 * max_tokens, it is also the routing: OpenRouter only sends a request to a provider that can
 * write that much, so a cheap provider with a small limit is passed over rather than setting
 * the limit for all (2026-09-30: GLM-5.3 at 524,288 went to InferenceNet, whose limit is
 * 943,718; at 128,000, to Relace, whose limit is 131,072). A provider that cannot take tools
 * or is down would never serve a turn, so it does not count; one that states no limit can
 * write its whole context.
 */
export function windowOf(endpoints: readonly Endpoint[]): number | undefined {
  const fits = endpoints
    .filter((e) => (e.status ?? 0) >= 0 && (e.supported_parameters?.includes('tools') ?? true))
    .map((e) => Math.min(e.max_completion_tokens || Infinity, Math.floor((e.context_length ?? 0) / 2)))
    .filter((n) => n > 0)
  return fits.length ? Math.max(...fits) : undefined
}

/** The model's providers. Public, CORS `*`, so the panel asks for them too. */
async function endpointsOf(id: string, get: typeof globalThis.fetch = fetch): Promise<Endpoint[]> {
  const r = await get(`https://openrouter.ai/api/v1/models/${id}/endpoints`, { signal: AbortSignal.timeout(5_000) })
  if (!r.ok) throw new Error(`OpenRouter answered ${r.status}`)
  return ((await r.json()) as { data: { endpoints: Endpoint[] } }).data.endpoints
}

/**
 * The model's thinking window (windowOf), from its providers. An alias lists none
 * (~anthropic/claude-sonnet-latest), so it takes the catalog's own figures; a router has
 * neither, and gets undefined: nothing is sent, and OpenRouter picks.
 */
export async function thinkingWindow(
  id: string,
  get: typeof globalThis.fetch = fetch,
  models: () => Promise<Model[]> = catalog,
): Promise<number | undefined> {
  const own = windowOf(await endpointsOf(id, get))
  if (own) return own
  const m = (await models()).find((x) => x.id === id)
  return m?.maxOut ? windowOf([{ max_completion_tokens: m.maxOut, context_length: m.ctx }]) : undefined
}

/**
 * The effort a step of the plan is built at (buildEffort), for the project's Thinking or, when
 * it has none, what the model does unasked — defaultEffort's, not the catalog's raw
 * default_effort: Opus 4.6–4.8 list 'high' there with reasoning off by default, and building
 * at 'medium' switched on a reasoning the panel said was off.
 */
export function buildEffortOf(m: Model | undefined, effort: Thinking | undefined): Effort | undefined {
  return buildEffort(effort ?? (m && defaultEffort(m)), m ? effortsOf(m) : [])
}

/**
 * The efforts to offer, highest first, without 'none' — that is `offAllowed` — and without
 * any EFFORTS does not know: the server refuses those, and a switch sends every effort
 * offered (see unfit), so one new level in the catalog made a switch to its model a 400.
 */
export function effortsOf(m: Model): Effort[] {
  if (!m.supported.has('reasoning')) return []
  const listed = m.reasoning?.supported_efforts === null ? [...EFFORTS] : (m.reasoning?.supported_efforts ?? [])
  return listed.filter((e) => e !== 'none' && EFFORTS.includes(e))
}

/** Only when the catalog says reasoning is optional: GLM refuses to be switched off. */
function offAllowed(m: Model): boolean {
  return m.supported.has('reasoning') && m.reasoning?.mandatory === false
}

/**
 * What the model does when no effort is sent. 'unknown' where the catalog does not say —
 * optional reasoning, no `default_enabled`, no `default_effort`: 52 tool models on
 * 2026-09-25, claude-sonnet-4.5 and claude-opus-4.5 among them — which this called on.
 */
export function defaultEffort(m: Model): string {
  const r = m.reasoning
  if (r?.default_enabled === false || r?.default_effort === 'none') return 'off'
  return r?.default_effort ?? (r?.default_enabled || r?.mandatory ? 'on' : 'unknown')
}

/**
 * What Thinking offers besides the model's default: its efforts, then, where reasoning is
 * optional, on and off — each only where it is not the default already, which the default's
 * own button says. 'on' only where no effort switches it on (deepseek-v3.2, grok-4.20,
 * claude-sonnet-4.5).
 */
export function thinkings(m: Model): Thinking[] {
  const efforts = effortsOf(m)
  if (!offAllowed(m)) return efforts
  const d = defaultEffort(m)
  return [...efforts, ...(efforts.length === 0 && d !== 'on' ? (['on'] as const) : []), ...(d === 'off' ? [] : (['none'] as const))]
}

/**
 * A switch to `m`, as a PATCH's `params`: null, which clears, for every knob `m` does not
 * take — all of them, not only the ones set, because the set on screen can be a save
 * behind. The effort goes every time, as the list of those `m` offers: the server keeps the
 * stored one only if it is on the list, deciding on what every save before the switch left
 * (see paramsPatch). A patch that left it out kept a Thinking click still in flight, and
 * stored 'off' on GLM, which refuses it.
 */
export function unfit(m: Model): { effort: Thinking[]; max_tokens: null } & Partial<Record<KnobKey, null>> {
  // The Thinking window goes too: it was chosen against the last model's providers.
  const out: { effort: Thinking[]; max_tokens: null } & Partial<Record<KnobKey, null>> = { effort: thinkings(m), max_tokens: null }
  for (const k of KNOBS) if (!m.supported.has(k.key)) out[k.key] = null
  return out
}

/**
 * The model to describe screenshots for a text-only one: the house describer if it can see —
 * it is cheap, and what every project on the default looks with — else the cheapest that
 * can. The house describer, not the house model: GLM-5.3 cannot see, and proposing by it
 * gave whichever vision model was cheapest that day.
 */
export function proposeLooker(models: Model[], houseLooker: string): string | undefined {
  if (models.find((m) => m.id === houseLooker)?.image) return houseLooker
  return models.filter((m) => m.image && m.prompt > 0).sort((a, b) => a.prompt - b.prompt)[0]?.id
}

export function price(m: Model): string {
  if (m.prompt < 0) return 'varies'
  if (m.prompt === 0 && m.completion === 0) return 'free'
  // Two significant digits under $1: to the cent, $0.045 and $0.035 were both $0.04. The
  // unary plus drops trailing zeros after rounding, so 9.99 reads $10, not $10.0.
  const f = (n: number) => `$${+(n < 1 ? n.toPrecision(2) : n.toFixed(n < 10 ? 1 : 0))}`
  return `${f(m.prompt)} / ${f(m.completion)}`
}

export function context(n: number): string {
  // The cut-off rounds like the k branch does, or 999 999 would read 1000k.
  return n >= 999_500 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`
}

/** The part after the author: `glm-5.3-flash`. */
export const short = (id: string) => id.slice(id.indexOf('/') + 1)
