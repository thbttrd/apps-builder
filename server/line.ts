/**
 * apps-builder's half of the line: a preview pod reaches nothing, so `/_ab/fetch`
 * is queued in the pod (preview-control.mjs) and fetched from here. Two long-polls into the pod's control
 * port stay outstanding while the preview runs; each GET they bring back runs through relayFetch — the
 * private-address rule, the limits — and its answer is posted back.
 *
 * What a poll brings back is data, not trusted: should the preview's container die, the app's server
 * (the model's code, on the pod's loopback) could bind the control port and answer the polls itself. So
 * an answer is read up to MAX_JOB bytes and must be a job, and at most MAX_IN_FLIGHT GETs run at once.
 */
import { RelayError, relayFetch } from './fetch-relay.mjs'

type Job = { id: string; url: string; headers: Record<string, string> }
type Options = { isPrivate?: (ip: string) => boolean }

/** Polls kept outstanding: a GET arriving while one poll is being answered still finds the other. */
const POLLS = 2
/** A job is an id, a URL and three forwarded headers: a few hundred bytes. */
const MAX_JOB = 64 * 1024
/** Relayed GETs one preview may have running at once; the polls wait while it is reached. */
const MAX_IN_FLIGHT = 8
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Hold the line into `control` (the pod's control port) until `signal` aborts. Never throws: a failed
 * poll — the pod starting, restarting or gone — is retried after a second.
 * `options.isPrivate` replaces relayFetch's rule for the tests only, as relayFetch's own option does.
 */
export function holdLine(control: string, token: string, signal: AbortSignal, options: Options = {}): void {
  const auth = { authorization: `Bearer ${token}` }
  let inFlight = 0
  const freed: (() => void)[] = []
  const answer = async (job: Job) => {
    try {
      const out = await relayed(job, options)
      await fetch(`${control}/_ab/line/${job.id}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(out),
        signal,
      }).catch(() => {})
    } finally {
      release()
    }
  }
  const release = () => {
    inFlight--
    freed.shift()?.()
  }
  const poll = async () => {
    while (!signal.aborted) {
      try {
        while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => freed.push(r))
        // The slot is taken before the poll goes out, so two polls can't both fill the last one; a poll
        // that brings no job gives it back.
        inFlight++
        let job: Job | null = null
        try {
          const r = await fetch(`${control}/_ab/line`, { headers: auth, signal })
          if (r.status === 204) continue
          if (r.status !== 200) throw new Error(`line: ${r.status}`)
          job = asJob(await capped(r, MAX_JOB))
          if (!job) throw new Error('line: not a job')
          void answer(job)
        } finally {
          if (!job) release()
        }
      } catch {
        if (!signal.aborted) await Bun.sleep(1000)
      }
    }
  }
  for (let i = 0; i < POLLS; i++) void poll()
}

/** The body, or a throw once it passes `max` bytes. */
async function capped(r: Response, max: number): Promise<string> {
  const reader = r.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = (await reader?.read()) ?? { done: true, value: undefined }
    if (done) break
    size += value.length
    if (size > max) {
      await reader?.cancel()
      throw new Error('line: answer too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString()
}

/** `text` as a job, or null: a UUID id, a string URL, string headers, nothing else. */
function asJob(text: string): Job | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const { id, url, headers } = v as Record<string, unknown>
  if (typeof id !== 'string' || !UUID.test(id) || typeof url !== 'string') return null
  if (!headers || typeof headers !== 'object' || Object.values(headers).some((h) => typeof h !== 'string')) return null
  return { id, url, headers: headers as Record<string, string> }
}

/** The site's answer as the line carries it — any status, JSON has no 200–599 rule — or the relay's refusal. */
async function relayed(job: Job, options: Options) {
  try {
    const out = await relayFetch(job.url, { headers: job.headers, isPrivate: options.isPrivate })
    return { status: out.status, headers: out.headers, body: out.body.toString('base64') }
  } catch (e) {
    return {
      status: e instanceof RelayError ? e.status : 502,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-ab-relay-error': '1' },
      body: Buffer.from(`relay: ${(e as Error).message}`).toString('base64'),
    }
  }
}
