/**
 * OpenRouter: the key, the house models and the route to a provider; the one-off calls that are
 * not the turn's loop — naming a project, answering a look — and the loop's own model, the most
 * it may write, and what its steps cost.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import { type Model, catalog, thinkingWindow } from '../shared/models'
import { type Params, requestBody, sentWindow } from '../shared/params'
import { slugify } from '../shared/slug'
import { usdOf } from './trace'

const API_KEY = Bun.env.OPENROUTER_API_KEY ?? ''
/**
 * House default; a project overrides it in its own metadata. GLM-5.3, not its flash: on the
 * plants build's stuck step, flash re-read everything and asked off-plan, and 5.3 did the
 * step as Sonnet 5 did (see the design log › GLM-5.3 as the house model).
 */
export const DEFAULT_MODEL = 'z-ai/glm-5.3'
/**
 * What describes screenshots for a project on the default, which cannot see them. A project
 * with a model of its own gets its describer from the settings panel, which proposes this
 * one. Both in the code only, not the env: an AB_MODEL that could see would still have sent
 * its looks here.
 */
export const DEFAULT_LOOK_MODEL = 'z-ai/glm-5.3-flash'
/**
 * Providers in price order, which is a fixed order, so the next request goes to the same
 * provider and finds its cache warm. Left to OpenRouter's balancing, a GLM-5.3 step cost
 * $0.28 and 45% of the input missed the cache on a provider switch; sorted, $0.18 (2026-09-26).
 * It does not reach the cheapest listed providers (see the design log › GLM-5.3 as the house model).
 */
const ROUTE = { sort: 'price' } as const
/**
 * The house model's, kept to the precision its quality was judged at (fp8, the $1.40 tier): in price
 * order 71% of dev's GLM-5.3 requests went to fp4 providers (traces, 2026-10-22), about $0.0065 a
 * request against $0.009. Not every model's: some are served only at fp4 or int4.
 */
const HOUSE_ROUTE = { ...ROUTE, quantizations: ['fp8', 'bf16', 'fp16'] as ('fp8' | 'bf16' | 'fp16')[] }

/** For the one-off call that answers check_app's `look`. Static, like SYSTEM. */
export const LOOK = `You are shown a screenshot of a web app that another model just changed, and asked one
question about it. Answer from what is actually visible, in at most four sentences. Say plainly
if anything is invisible, unreadable against its background, cut off, overlapping or
misaligned. Describe what you see; do not suggest code.`

export function configured(): boolean {
  return API_KEY !== ''
}

/**
 * A model for a one-off call — naming a project, answering a look — at reasoning 'low', not off:
 * GLM refuses `enabled: false` ("Reasoning is mandatory"), and at its default it spent 729
 * reasoning tokens and 19 s describing one screenshot; at 'low', 0 tokens and 9 s for an answer
 * just as right (measured 2026-09-22).
 */
export function describer(id: string) {
  return createOpenRouter({ apiKey: API_KEY }).chat(id, { usage: { include: true }, reasoning: { effort: 'low' }, provider: ROUTE })
}

/** For the one-off call that names a project from the prompt it is started with. */
const NAME = `Name the web app the message describes, in two to four plain words, as its title bar
would say it: "Simple Sheet", "Plant Diary", "Trip Budget". The name is in the Latin alphabet
only: in the message's own language when it is written in that alphabet (French, Spanish,
German…), and in English when it is not (Japanese, Russian, Arabic…). Reply with the name only.`
/** A create waits on it, so it gives up well before anyone would. */
const NAME_TIMEOUT_MS = 8_000

/**
 * A project's name, from its first prompt, and what naming it cost: one call to the house
 * describer. Anything that goes wrong — no key, a timeout, an error, an answer that makes no
 * slug — falls back to the prompt's first words, for nothing: a create must not fail for want
 * of a name, and the header renames it.
 *
 * The slug is a DNS label, so the name has to make one (see slug.ts). The describer is told
 * the Latin alphabet, and English for a message outside it: told only "Latin letters, in the
 * message's language", glm-5.3-flash named a Japanese prompt 家計簿アプリ two times in three,
 * and in English five in five once English was named (2026-09-27, NAME's wording 14 of 14 over
 * Japanese, Russian, French and English). Its answer and the first words are each kept only if
 * they make a slug, and a prompt in a script slugify drops, with no key or no usable answer,
 * is "New App".
 */
export async function nameFor(prompt: string): Promise<{ name: string; usd: number }> {
  const words = prompt.split(/\s+/).slice(0, 5).join(' ')
  const fallback = { name: slugify(words) ? words : 'New App', usd: 0 }
  if (!configured()) return fallback
  try {
    const r = await generateText({
      abortSignal: AbortSignal.timeout(NAME_TIMEOUT_MS),
      model: describer(DEFAULT_LOOK_MODEL),
      system: NAME,
      prompt: prompt.slice(0, 2000),
    })
    const usd = usdOf(r.providerMetadata)
    // The first line, without the quotes or the full stop a model adds, at most six words.
    const name = (r.text.trim().split('\n')[0] ?? '')
      .replace(/^["'“”*\s]+|["'“”*.\s]+$/g, '')
      .split(/\s+/)
      .slice(0, 6)
      .join(' ')
    return slugify(name) ? { name, usd } : { ...fallback, usd }
  } catch (e) {
    console.error('[name]', (e as Error).message)
    return fallback
  }
}

/** Per model id, for ten minutes: the window counts only providers that are up, and which are
 *  changes by the minute. A failure is asked again on the next turn. */
const limits = new Map<string, { at: number; window: Promise<number | undefined> }>()
const LIMIT_MS = 10 * 60_000

/**
 * The model's thinking window (windowOf in shared/models.ts), which a project's own Thinking
 * window may lower (sentWindow) and which goes out as max_tokens. Unsent, OpenRouter fills in
 * its own figure, and for Claude that was 65,536 of the 128,000 it can write: on Sonnet at
 * xhigh, two turns of running-fox thought for the whole 65,536, were cut off before a single
 * tool call, and cost $0.66 each for nothing (2026-09-29, see the design log › Output limit).
 *
 * The largest a provider allows, not the smallest: the smallest let one small provider — one
 * that cannot even take tools — cut gpt-oss-120b to 4,096 for every request, and it is the
 * window that picks the provider, price only among those that can write it. Half the context
 * at most, or a conversation past the rest is refused by every provider (Grok 4.x offers
 * 450,000 of its 500,000). A failed lookup sends nothing, and the next turn asks again.
 */
export function outputLimit(
  id: string,
  get: typeof globalThis.fetch = fetch,
  models: () => Promise<Model[]> = catalog,
  now = Date.now(),
): Promise<number | undefined> {
  const known = limits.get(id)
  if (known && now - known.at < LIMIT_MS) return known.window
  const window = thinkingWindow(id, get, models).catch((e: Error) => {
    console.error(`[limit ${id}]`, e.message)
    limits.delete(id)
    return undefined
  })
  limits.set(id, { at: now, window })
  return window
}

/** What a message's steps cost, as OpenRouter reported it: 0 for a step it reported none for. */
export type Costed = { providerMetadata?: Record<string, unknown> }

/**
 * Summed over every step, NOT read off `result.providerMetadata` — the SDK's own types call
 * that "metadata from the final step" and deprecate it. `result.usage` *is* aggregated, so
 * reading both together reported a whole turn's tokens beside one step's cost: measured
 * 2026-09-21, $0.000148 charged as $0.001013.
 */
export function costOf(steps: readonly Costed[]): number {
  return steps.reduce((sum, s) => sum + usdOf(s.providerMetadata), 0)
}

/**
 * The model the turn's loop talks to, with the project's parameters in its request body, and
 * its Thinking window within the model's (`full`, outputLimit) as max_tokens.
 * Exported for test/settings.test.ts, which hands it a stub `fetch` to read that body.
 */
export function loopModel(id: string, params: Params, full?: number, fetch?: typeof globalThis.fetch) {
  return createOpenRouter({ apiKey: API_KEY, fetch }).chat(id, {
    maxTokens: sentWindow(params.max_tokens, full),
    // cache_control makes Anthropic cache the stable prefix automatically; 1h outlasts
    // a chat left for lunch, where the default 5m would pay the write again.
    cache_control: { type: 'ephemeral', ttl: '1h' },
    // OpenRouter reports what the call actually cost, including whichever upstream
    // provider it routed to. Multiplying our own token counts by a price table would
    // drift the moment a rate changes or a request falls back to another provider.
    usage: { include: true },
    provider: id === DEFAULT_MODEL ? HOUSE_ROUTE : ROUTE,
    // Spread over the provider's own settings, usage and cache_control above among them, so
    // only what cleanParams passed may get here (see params.ts).
    extraBody: requestBody(params),
  })
}
