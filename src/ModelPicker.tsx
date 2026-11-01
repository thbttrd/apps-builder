import { useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { type Model, context, price, short } from '../shared/models'
import { GROUP, INPUT, OFF, ON } from './ui'

function Sight({ image }: { image: boolean }) {
  return image ? (
    <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
      images
    </span>
  ) : (
    <span className="shrink-0 rounded bg-current/10 px-1.5 py-0.5 text-xs opacity-70">text only</span>
  )
}

export function ModelLine({ m, id, note }: { m?: Model; id?: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="font-mono min-w-0 break-all">{m?.id ?? id}</span>
      {note && <span className="opacity-50">({note})</span>}
      {m && (
        <>
          <Sight image={m.image} />
          <span className="opacity-60" title="$ per million tokens, input / output">
            {price(m)}
          </span>
          <span className="opacity-60" title="context window">
            {context(m.ctx)}
          </span>
        </>
      )}
    </div>
  )
}

type Sighted = 'all' | 'images' | 'text'

/** A searchable list, closed until asked for: a few hundred rows is not a thing to scroll past. */
export default function ModelPicker({
  label,
  models,
  current,
  house,
  onPick,
}: {
  label: string
  models: Model[]
  current?: string
  /** Offer going back to the house default. */
  house?: string
  onPick: (id: string) => void
}) {
  const [browsing, setBrowsing] = useState(false)
  const [query, setQuery] = useState('')
  const [sighted, setSighted] = useState<Sighted>('all')
  const opener = useRef<HTMLButtonElement>(null)
  // Focus goes back to the button that opened the list: the row or cancel just pressed
  // unmounts, which would drop it on <body>, and a keyboard user back at the top of the page.
  const close = () => {
    flushSync(() => setBrowsing(false))
    opener.current?.focus()
  }
  const both = models.some((m) => m.image) && models.some((m) => !m.image)
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return models.filter(
      (m) =>
        words.every((w) => m.id.includes(w)) &&
        (sighted === 'all' || (sighted === 'images') === m.image),
    )
  }, [models, query, sighted])

  if (!browsing) {
    return (
      <div className="flex flex-wrap gap-2">
        <button
          ref={opener}
          type="button"
          onClick={() => setBrowsing(true)}
          className="rounded-lg border border-current/20 px-2.5 py-2 md:py-1 text-sm hover:bg-current/5"
        >
          {label}
        </button>
        {house && (
          <button
            type="button"
            onClick={() => {
              // This button goes once the project is back on the default, and focus with it.
              opener.current?.focus()
              onPick('')
            }}
            className="rounded-lg px-2.5 py-2 md:py-1 text-sm opacity-45 hover:opacity-100"
          >
            Back to the house default ({short(house)})
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="space-y-2 rounded-lg border border-current/10 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          type="search"
          aria-label="search models"
          placeholder="search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Escape leaves the list.
          onKeyDown={(e) => e.key === 'Escape' && close()}
          // A real basis, so the row wraps before the field shrinks: with flex-1's 0 it was
          // what the filter and cancel left over, 29 px of a 320 px chat.
          className={INPUT + ' min-w-0 grow basis-40'}
        />
        {both && (
          <div className={`${GROUP} flex`} role="group" aria-label="image input">
            {(['all', 'images', 'text'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sighted === s}
                onClick={() => setSighted(s)}
                className={`rounded-md px-2 py-2 md:py-1 text-sm ${sighted === s ? ON : OFF}`}
              >
                {s === 'text' ? 'text only' : s}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={close} className="px-2 py-2 md:py-1 text-sm opacity-45 hover:opacity-100">
          cancel
        </button>
      </div>
      <p className="text-sm opacity-45">
        {shown.length} models · price is $ per million tokens in / out
      </p>
      <ul className="max-h-64 overflow-y-auto overscroll-contain">
        {shown.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              aria-current={m.id === current || undefined}
              onClick={() => {
                setQuery('')
                close()
                if (m.id !== current) onPick(m.id)
              }}
              className={`w-full rounded-md px-2 py-2 md:py-1.5 text-left text-sm hover:bg-current/5 ${m.id === current ? 'bg-current/10' : ''}`}
            >
              {/* Two lines: at 384 px one line left `anthropic/cl…` of every id, and the
                  id is the thing being chosen. */}
              <span className="block font-mono break-all">{m.id}</span>
              <span className="mt-0.5 flex items-center gap-2 tabular-nums">
                <Sight image={m.image} />
                <span className="opacity-60">{price(m)}</span>
                <span className="opacity-60">{context(m.ctx)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
