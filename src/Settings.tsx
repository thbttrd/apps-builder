import { useEffect, useState } from 'react'
import { KNOBS, type Params, THINKING_ABOUT, type Thinking, WINDOWS, WINDOW_ABOUT } from '../shared/params'
import type { SettingsChange } from './api'
import {
  type Model,
  catalog,
  context,
  defaultEffort,
  effortsOf,
  proposeLooker,
  short,
  thinkingWindow,
  thinkings,
  unfit,
} from '../shared/models'
import { Problem } from './Harness'
import KnobField from './KnobField'
import ModelPicker, { ModelLine } from './ModelPicker'
import { useLatest } from './hooks'
import type { Target } from './More'
import { GROUP, INPUT, LEGEND, OFF, ON, SEGMENT } from './ui'

/**
 * More › Settings: which model answers, and with what parameters. It offers only what the
 * chosen model takes, as its catalog entry says — an effort it does not list, or a knob none
 * of its providers honour, would be dropped upstream without a word.
 *
 * A section of the More pane, which the workspace mounts only while it shows, as it does
 * History. It used to be a disclosure over the chat; Lovable keeps the chat to the
 * conversation, and this is where it keeps its settings. The start page shows it too, over the
 * settings a new project will be made with (see Target).
 */
export default function Settings({ target }: { target: Target }) {
  const { settings, house, houseLooker, askHouse, busy, talked } = target
  const [models, setModels] = useState<Model[] | null>(null)
  const [failed, setFailed] = useState('')
  const [error, setError] = useState<{ at: string; text: string } | null>(null)

  // Once per showing of the pane, which mounts this, so a failed fetch gets another go when
  // More is opened again. Once the list has loaded, catalog() hands back the same settled
  // promise and fetches nothing.
  useLatest(
    catalog,
    [],
    (m) => {
      setModels(m)
      setFailed('')
    },
    (e) => setFailed(e.message),
  )

  // `house` (DEFAULT_MODEL, the model a project without one uses). When it failed to load, a
  // project on the default has no model to show — so showing the pane asks again.
  useEffect(() => {
    if (!house) askHouse()
  }, [house, askHouse])

  const params = settings.params ?? {}
  /** '' while a project on the default waits for `house`. */
  const current = settings.model ?? house
  const model = models?.find((m) => m.id === current)

  // The model's thinking window, from its providers — what the server sends when the project
  // sets none. Unknown (loading, a router, a failed lookup): no Thinking window section, unless
  // the project has one, which still goes out and has to be clearable.
  const [lookup, setLookup] = useState<{ id: string; tokens: number | undefined }>()
  useLatest(
    () => (current ? thinkingWindow(current).then((tokens) => ({ id: current, tokens })) : undefined),
    [current],
    setLookup,
  )
  const modelWindow = lookup?.id === current ? lookup.tokens : undefined
  // Not within a tenth of the default: 512k beside a default of 524k changes nothing.
  const windows = modelWindow ? WINDOWS.filter((w) => w <= modelWindow * 0.9) : []
  // A project on the default has no describer of its own and looks with the house's.
  const looker = settings.lookModel ?? (settings.model ? undefined : houseLooker || undefined)
  // The Thinking button pressed. Off where off is the default, and on where on is, have no
  // button — the default's says the same — but can be stored: saved before Thinking left
  // them out, or by hand. They press the default's, which is what they do.
  // 'unknown' where the catalog does not say what the model does unasked: its button then
  // says just 'default', not a guess.
  const effortDefault = model && defaultEffort(model)
  const asDefault = (params.effort === 'none' && effortDefault === 'off') || (params.effort === 'on' && effortDefault === 'on')
  const chosen = asDefault ? undefined : params.effort

  /**
   * `params` is a change, not a set: a value sets its key, null clears it, null for the whole
   * of it clears them all, and a list for the effort keeps the stored one only if it is on
   * the list. The server applies it to what is stored, in its write queue. A
   * whole set built from `params` here put back what a save still in flight had changed:
   * the prop is only refetched once a PATCH returns.
   */
  const save = async (at: string, patch: SettingsChange) => {
    setError(null)
    try {
      await target.save(patch)
    } catch (e) {
      setError({ at, text: (e as Error).message })
    }
  }

  const pick = (next: string) => {
    const m = models?.find((x) => x.id === (next || house))
    // Not in the catalog — it failed to load, or does not list this id — so nothing says
    // which effort or knobs the model takes (GLM refuses to be switched off): all go. The
    // describer stays: it can see, whatever this model can, and '' would send the looks to
    // this model — but not on the way back to the house default, which looks with the house's.
    if (!m) return void save('model', { model: next, params: null, ...(next ? {} : { lookModel: '' }) })
    // An effort pressed as the default's (above) is not carried over: the panel said the
    // model's default was in effect, so the next model gets its own, not an off or on
    // nobody chose here.
    const fit = unfit(m)
    if (asDefault) fit.effort = fit.effort.filter((e) => e !== params.effort)
    void save('model', {
      model: next,
      params: fit,
      // Propose a describer the moment a model that cannot see is picked; drop it when the
      // next one can see for itself, or when the project goes back to the house default,
      // which looks with the house's describer. None while `houseLooker` is unknown:
      // proposeLooker would pass over it for the cheapest that can see.
      lookModel: m.image || !next ? '' : looker || (houseLooker && models && proposeLooker(models, houseLooker)) || '',
    })
  }

  const setParam = (key: keyof Params, value: number | Thinking | undefined) =>
    void save(key, { params: { [key]: value ?? null } })

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-4 py-6 text-sm md:px-8 md:py-8">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="opacity-60">
          {target.kind === 'draft'
            ? 'The model that will answer in the new project’s chat, and how. The project starts with these.'
            : 'The model that answers in this project’s chat, and how. Changes save as you make them.'}
        </p>
      </div>
      {busy && (
        <p className="rounded-md bg-current/5 p-2.5 text-sm opacity-70">
          A turn is running. Changes apply from the next message.
        </p>
      )}

      <section className="space-y-2">
        <Heading>Model</Heading>
        {failed ? (
          <>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Couldn’t load OpenRouter’s model list ({failed}); it is fetched again the next time More opens.
              Meanwhile, type a model id: it starts from its own defaults.
            </p>
            <input
              aria-label="model id"
              className={INPUT + ' w-full'}
              placeholder={house}
              defaultValue={settings.model ?? ''}
              key={settings.model ?? ''}
              // Trimmed, as the server stores it: a pasted id with a space after it is
              // the same model, not a switch that resets its parameters.
              onBlur={(e) => e.target.value.trim() !== (settings.model ?? '') && pick(e.target.value.trim())}
              // Escape cancels, as in a knob's field: the stored id goes back, so the
              // blur that follows saves nothing.
              onKeyDown={(e) => {
                if (e.key === 'Escape') e.currentTarget.value = settings.model ?? ''
              }}
            />
          </>
        ) : !models ? (
          <p className="text-sm opacity-50">Loading OpenRouter’s models…</p>
        ) : (
          <>
            {model ? (
              <ModelLine m={model} note={settings.model ? undefined : 'house default'} />
            ) : current ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                <span className="font-mono">{current}</span> is not in OpenRouter’s list of models that can
                call tools, so its parameters are unknown and the agent may not be able to edit files.
              </p>
            ) : (
              <p className="text-sm opacity-50">The house default hasn’t loaded yet; it is asked for again the next time More opens.</p>
            )}
            <ModelPicker
              label="Change model"
              models={models}
              current={current}
              onPick={pick}
              house={settings.model && settings.model !== house ? house : undefined}
            />
            {talked && (
              <p className="text-sm opacity-60">
                Switching model mid-chat: the next message re-reads the whole conversation uncached, at full
                price, once.
              </p>
            )}
          </>
        )}
        <Problem at="model" error={error} />
      </section>

      {model && !model.image && models && (
        <section className="space-y-2">
          <Heading>Screenshot describer</Heading>
          <p className="text-sm opacity-60">
            {short(model.id)} can’t see images. When the agent asks check_app to look at the page, this model
            looks at the screenshot instead and describes it in words for {short(model.id)}.
          </p>
          {looker ? (
            <ModelLine
              m={models.find((m) => m.id === looker)}
              id={looker}
              note={!settings.lookModel ? 'house default' : houseLooker && looker === proposeLooker(models, houseLooker) ? 'proposed' : undefined}
            />
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              None set — a look will fail and the agent checks the page by its outline only.
            </p>
          )}
          <ModelPicker label="Change describer" models={models.filter((m) => m.image)} current={looker} onPick={(v) => void save('lookModel', { lookModel: v })} />
          <Problem at="lookModel" error={error} />
        </section>
      )}

      {model && thinkings(model).length > 0 && (
        <section className="space-y-2">
          <Heading>Thinking</Heading>
          <div className={`${GROUP} flex flex-wrap w-fit`} role="group" aria-label="thinking effort">
            {[undefined, ...thinkings(model)].map((e) => (
              <button
                key={e ?? 'default'}
                type="button"
                aria-pressed={chosen === e}
                onClick={() => setParam('effort', e)}
                className={`${SEGMENT} ${chosen === e ? ON : OFF}`}
              >
                {e === undefined ? (effortDefault === 'unknown' ? 'default' : `default (${effortDefault})`) : e === 'none' ? 'off' : e}
              </button>
            ))}
          </div>
          <p className="text-sm opacity-60">{THINKING_ABOUT}</p>
          {model.reasoning?.mandatory && <p className="text-sm opacity-60">This model always reasons; it cannot be switched off.</p>}
          <Problem at="effort" error={error} />
        </section>
      )}
      {model && effortsOf(model).length === 0 && model.reasoning?.mandatory && (
        <section className="space-y-1">
          <Heading>Thinking</Heading>
          <p className="text-sm opacity-60">Always on — this model reasons at a level it picks itself.</p>
        </section>
      )}

      {model && (modelWindow || params.max_tokens !== undefined) && (
        <section className="space-y-2">
          <Heading>Thinking window</Heading>
          <div className={`${GROUP} flex flex-wrap w-fit`} role="group" aria-label="thinking window">
            {[undefined, ...windows].map((w) => (
              <button
                key={w ?? 'default'}
                type="button"
                aria-pressed={params.max_tokens === w}
                onClick={() => setParam('max_tokens', w)}
                className={`${SEGMENT} tabular-nums ${params.max_tokens === w ? ON : OFF}`}
              >
                {w === undefined ? (modelWindow ? `default (${context(modelWindow)})` : 'default') : context(w)}
              </button>
            ))}
          </div>
          <p className="text-sm opacity-60">{WINDOW_ABOUT}</p>
          {/* Set by hand, or before the model's providers changed: no button says it. */}
          {params.max_tokens !== undefined && !windows.includes(params.max_tokens) && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {params.max_tokens.toLocaleString('en-US')} tokens is set
              {modelWindow && params.max_tokens > modelWindow ? `, more than this model offers: ${modelWindow.toLocaleString('en-US')} go out` : ''}.
            </p>
          )}
          <Problem at="max_tokens" error={error} />
        </section>
      )}

      {model && (
        <section className="space-y-3">
          <Heading>Sampling</Heading>
          {KNOBS.filter((k) => model.supported.has(k.key)).map((k) => (
            <KnobField
              key={k.key}
              knob={k}
              value={params[k.key]}
              modelDefault={model.defaults[k.key] ?? undefined}
              onSet={(v) => setParam(k.key, v)}
              error={error?.at === k.key ? error.text : undefined}
            />
          ))}
          {KNOBS.some((k) => !model.supported.has(k.key)) && (
            <p className="text-sm opacity-45">
              Not offered by this model: {KNOBS.filter((k) => !model.supported.has(k.key)).map((k) => k.label).join(', ')}.
            </p>
          )}
        </section>
      )}

      {Object.keys(params).length > 0 && (
        <button
          type="button"
          onClick={() => void save('params', { params: null })}
          className="rounded-lg border border-current/20 px-2.5 py-2 md:py-1 text-sm hover:bg-current/5"
        >
          Reset all to the model’s defaults
        </button>
      )}
      <Problem at="params" error={error} />
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className={LEGEND}>{children}</h3>
}
