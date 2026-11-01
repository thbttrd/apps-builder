import { useEffect, useId, useRef } from 'react'
import type { Knob } from '../shared/params'
import { INPUT } from './ui'

export default function KnobField({
  knob,
  value,
  modelDefault,
  onSet,
  error,
}: {
  knob: Knob
  value?: number
  modelDefault?: number
  onSet: (v: number | undefined) => void
  error?: string
}) {
  const fid = useId()
  // Short, or it clips in the input: the model's own recommendation where it publishes
  // one, else what providers usually do when the key is left out.
  const fallback =
    modelDefault !== undefined ? `default ${modelDefault}` : knob.typical !== undefined ? `usually ${knob.typical}` : 'random'
  const input = useRef<HTMLInputElement>(null)
  // A refused entry gives way to the stored value while its error shows: left in place, it
  // read as in effect once the error went. Not under the cursor, though: remounting the
  // field for it dropped focus from a field just clicked or being typed in, and the typing.
  useEffect(() => {
    if (error && input.current && input.current !== document.activeElement) input.current.value = String(value ?? '')
  }, [error, value])
  const commit = (text: string) => {
    // A comma as the decimal point too, in a fractional knob: in a comma-decimal locale that
    // is the only separator a phone's decimal pad offers. In a whole-number one it can only
    // group thousands — 1,000 in Top-k was saved as 1 — so it stays, and is refused.
    const t = knob.int ? text.trim() : text.trim().replace(',', '.')
    if (t === '' ? value === undefined : Number(t) === value) return
    // Sent as typed, even out of range: the server's refusal is the one that counts, and
    // it names the range. NaN and ±Infinity would serialise as null, which clears, so
    // they go as text.
    const n = Number(t)
    onSet(t === '' ? undefined : Number.isFinite(n) ? n : (t as unknown as number))
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label htmlFor={fid} className="min-w-0 flex-1 text-sm font-medium">
          {knob.label}{' '}
          <span className="font-normal opacity-45">
            {knob.min}–{knob.max === 2147483647 ? '2³¹−1' : knob.max}
          </span>
        </label>
        <input
          id={fid}
          type="text"
          // iOS's decimal pad has no minus key, so the penalties, which go below 0, get text.
          inputMode={knob.min < 0 ? 'text' : 'decimal'}
          placeholder={fallback}
          title={
            modelDefault !== undefined
              ? `Empty: the model's recommended ${modelDefault}`
              : `Empty: not sent, so the provider applies its own default${knob.typical !== undefined ? ` (usually ${knob.typical})` : ''}`
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${fid}e` : undefined}
          ref={input}
          defaultValue={value ?? ''}
          key={value ?? ''}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            // Escape cancels the edit: the stored value goes back, so the blur that
            // follows has nothing to save.
            if (e.key === 'Escape') e.currentTarget.value = String(value ?? '')
          }}
          className={INPUT + ' w-44 md:w-40 text-right'}
        />
        <button
          type="button"
          onClick={() => onSet(undefined)}
          disabled={value === undefined}
          aria-label={`reset ${knob.label} to default`}
          title="reset to the default"
          className="shrink-0 rounded-md px-2 py-2 md:py-1 text-sm opacity-45 hover:opacity-100 disabled:invisible"
        >
          ↺
        </button>
      </div>
      <p className="text-sm opacity-60">{knob.about}</p>
      {error && (
        <p id={`${fid}e`} role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
    </div>
  )
}
