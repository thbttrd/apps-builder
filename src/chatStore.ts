/**
 * Chat turns live here, not in the component.
 *
 * A turn used to be a closure inside <Chat>, so switching projects unmounted it and
 * every streamed token was written into a dead component. The turn kept running and
 * the answer was thrown away; coming back refetched history, which the server writes
 * only once the loop finishes, so the panel was empty until a reload.
 *
 * This module outlives any mount. <Chat> is a view onto it.
 */
// The wire shape is the server's, so it is imported rather than re-declared: a fifth
// event or a renamed tool used to typecheck fine against a local copy while the code
// pane silently stopped refreshing.
import { type Activity, type ChatEvent as Event, type ChatGet, type Usage, api } from './api'
import { type Reply, type Turn, fold, reply, said, shows, toTurns } from './turns'

/** The live turn's activity line. `since` restarts only when what it is doing changes. */
export type Live = Activity & { since: number }

/**
 * Ids for the turns send() and the `note` event add: a stored turn's id starts with a digit,
 * so none of these can equal one, and the count only goes up, so none equals another.
 */
let made = 0
const fresh = () => `live ${++made}`

export type State = {
  turns: Turn[]
  /** The unsent textarea draft — part of "the project as I left it". */
  draft: string
  busy: boolean
  usage: Usage | null
  /**
   * The project's tally as this tab's turn last booked it, 0 before one has: the listing's
   * `usd` is refetched when a turn settles or the workspace changes something, not as a turn
   * books. Only ever goes up, as the tally does, so the counter shows the larger of the two;
   * forget() drops it with the rest, and a forgotten turn stops writing it (generations).
   */
  usd: number
  ready: boolean
  defaultModel: string
  /** What describes screenshots for a project on the default model. */
  defaultLookModel: string
  /** History has been fetched at least once, so a remount must not refetch over a live turn. */
  loaded: boolean
  /** True when this tab owns the stream. False + busy means a turn we can only watch. */
  attached: boolean
  /** Bumped once per finished write, delete or artefact save, so the panes refetch per batch. */
  writes: number
  /** The file the newest finished write_file or edit_file named, as the model wrote its path: a
   *  new object each time, so the code pane follows the agent into it (Files). */
  wrote: { path: string } | null
  /** Only while this tab is attached to a turn. */
  activity: Live | null
  /**
   * When the stream last delivered anything, to the second, the server's 15 s `: ping`
   * included. That heartbeat runs whatever the model is doing, so a long silence here is
   * the connection, not the model.
   */
  heard: number
}

const EMPTY: State = {
  turns: [],
  draft: '',
  busy: false,
  usage: null,
  usd: 0,
  ready: true,
  defaultModel: '',
  defaultLookModel: '',
  loaded: false,
  attached: false,
  writes: 0,
  wrote: null,
  activity: null,
  heard: 0,
}

const states = new Map<string, State>()
const listeners = new Map<string, Set<() => void>>()
/**
 * slug -> bumped by forget(). A delete forgets a project while its turn may still stream, and
 * send() stops at the next chunk rather than write a state back under the slug: a `spent`
 * still on the wire put the deleted project's tally on the next project to take its name.
 */
const generations = new Map<string, number>()

/** useSyncExternalStore compares by reference, so this must not build a new object. */
export function get(slug: string): State {
  return states.get(slug) ?? EMPTY
}

export function subscribe(slug: string, notify: () => void): () => void {
  let set = listeners.get(slug)
  if (!set) listeners.set(slug, (set = new Set()))
  set.add(notify)
  return () => {
    set.delete(notify)
    if (set.size === 0) listeners.delete(slug)
  }
}

export function forget(slug: string): void {
  const timer = watchers.get(slug)
  if (timer) {
    clearInterval(timer)
    watchers.delete(slug)
  }
  states.delete(slug)
  generations.set(slug, (generations.get(slug) ?? 0) + 1)
  // Notify, never delete the Set: a subscriber that is still mounted — a rename whose
  // slug came back unchanged does not remount <Chat key={slug}> — would otherwise be
  // orphaned, and every later setDraft/send/touched would reach nobody. Subscribers drop
  // their own entry when the last one unsubscribes, so nothing leaks.
  listeners.get(slug)?.forEach((notify) => notify())
}

function update(slug: string, patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const prev = get(slug)
  states.set(slug, { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) })
  listeners.get(slug)?.forEach((notify) => notify())
}

export function setDraft(slug: string, draft: string): void {
  update(slug, { draft })
}

/**
 * Bump the write counter without a turn. The code pane refetches off it, and a restore
 * moves files just as much as a write_file does — it just does not come down the stream.
 */
export function touched(slug: string): void {
  update(slug, (s) => ({ writes: s.writes + 1 }))
}

/** Polls for turns this tab is not attached to — started elsewhere, or before a reload. */
const watchers = new Map<string, ReturnType<typeof setInterval>>()

function watch(slug: string): void {
  if (watchers.has(slug)) return
  const timer = setInterval(async () => {
    try {
      // api(), not a bare fetch+cast: it throws before clearInterval below, so a
      // transient failure leaves the watcher polling instead of unregistering it and
      // then throwing `messages.filter is not a function` into the empty catch — which
      // left the project busy:true forever, with no next tick to recover it.
      const d = await api<ChatGet>(`/api/projects/${slug}/chat`)
      if (d.running || get(slug).attached) return
      clearInterval(timer)
      watchers.delete(slug)
      update(slug, { busy: false, turns: toTurns(d.messages) })
      settledListener?.()
    } catch {
      // transient; the next tick tries again
    }
  }, 2000)
  watchers.set(slug, timer)
}

export async function load(slug: string): Promise<void> {
  if (get(slug).loaded) return
  try {
    const d = await api<ChatGet>(`/api/projects/${slug}/chat`)
    const meta = { ready: d.configured, defaultModel: d.defaultModel, defaultLookModel: d.defaultLookModel, loaded: true }
    // A turn may have started while this was in flight; its turns are newer than the
    // history we just fetched, which by definition does not contain it yet.
    if (get(slug).busy) return update(slug, meta)
    update(slug, { ...meta, busy: d.running, turns: toTurns(d.messages) })
    // A turn is running that this tab did not start — after a reload, or in another tab.
    // Without this the UI shows "send" and the turn cannot be stopped from here at all.
    if (d.running) watch(slug)
  } catch {
    // Deliberately no update: latching `loaded` here would close every retry path —
    // load() returns early on it, reload() only runs after a restore — and `ready:false`
    // renders as "OPENROUTER_API_KEY is not set" with the composer disabled. One failed
    // fetch during a unit restart used to mean a dead chat pane until a page reload.
  }
}

/**
 * Refetch history over what is on screen, for when the stored conversation changed
 * without this tab doing it — a code+chat restore rewinds it.
 *
 * load() cannot do this: it returns early once `loaded` is set, which is exactly what
 * stops a remount from refetching over a live turn. forget() would work but takes the
 * unsent draft with it, and the draft is part of "the project as I left it".
 */
export async function reload(slug: string): Promise<void> {
  // A turn's own turns are newer than any history on disk, which cannot contain it yet.
  if (get(slug).busy) return
  // Throws, for the caller to say so: swallowed, the old conversation stayed on screen
  // under a restore that reported success.
  const d = await api<ChatGet>(`/api/projects/${slug}/chat`)
  update(slug, { turns: toTurns(d.messages), usage: null })
}

/**
 * Ask the server to stop the turn. The server owns it — the stream keeps running when
 * this component is unmounted, so aborting the client's reader alone would leave a
 * paid loop with nobody watching it.
 */
export async function stop(slug: string): Promise<void> {
  await api(`/api/projects/${slug}/chat/stop`, { method: 'POST' })
}

/**
 * Who hears a turn end, sent from this tab or only watched: App, which refetches the listing.
 * The workspace learns of the first build from the listing, which only this refreshes; a first
 * build that ended while watched left the preview out until a reload.
 */
let settledListener: (() => void) | undefined

/** Hear every turn end, until the returned function is called. */
export function onSettled(listener: () => void): () => void {
  settledListener = listener
  return () => {
    if (settledListener === listener) settledListener = undefined
  }
}

/** The live reply, changed: always the newest turn, which send() put there. */
const patchLast = (slug: string, fn: (t: Reply) => Reply) =>
  update(slug, (s) => ({ turns: s.turns.map((t, i) => (i === s.turns.length - 1 && t.role === 'assistant' ? fn(t) : t)) }))

/**
 * One event of the turn this tab sent, into the store: the reply grows, a note goes where the
 * stored history keeps it, a settled write tells the panes, and the activity line, the tally and
 * the usage line move. `answering`: the message answers the question the last turn ended on.
 */
function apply(slug: string, e: Event, answering: boolean): void {
  if (e.type === 'text' || e.type === 'thought') patchLast(slug, (t) => fold(t, e))
  // Where the stored history has it, so a reload does not move it: before the message
  // it arrived with, or after it when that message is an answer, which has to follow
  // its question directly — or, `after`, under the turn it ended.
  else if (e.type === 'note') {
    const at = e.after ? undefined : answering ? -1 : -2
    update(slug, (s) => ({
      turns: [
        ...s.turns.slice(0, at),
        { id: fresh(), role: 'user', text: e.text, note: true },
        ...(at === undefined ? [] : s.turns.slice(at)),
      ],
    }))
  }
  else if (e.type === 'ask')
    patchLast(slug, (t) => ({ ...t, ask: [...(t.ask ?? []), ...e.questions], askId: t.askId ?? e.id, ...(e.plan && { plan: e.plan }) }))
  else if (e.type === 'tool') {
    // Upsert by id: the row is created when the tool is announced and gains its
    // path once the arguments finish streaming.
    patchLast(slug, (t) => fold(t, e))
    // Only a settled write, edit, delete or artefact save moved the filesystem. Announcing a
    // tool did not, calling one did not — measured at 13.8s early — and read_file
    // never does, so the panes would refetch for nothing on all three.
    if (e.done && (e.name === 'write_file' || e.name === 'edit_file' || e.name === 'delete_file' || e.name === 'save_spec' || e.name === 'update_plan' || e.name === 'save_design_md')) {
      const into = (e.name === 'write_file' || e.name === 'edit_file') && e.path
      update(slug, (s) => ({ writes: s.writes + 1, ...(into && { wrote: { path: into } }) }))
    }
  }
  else if (e.type === 'activity')
    update(slug, ({ activity: was }) => ({
      activity: {
        doing: e.doing,
        what: e.what,
        // `what` is only ever the tool now, so a new tool is a new activity and gets
        // its own clock. The reasoning comes as `thought` and does not touch this.
        since: was?.doing === e.doing && was.what === e.what ? was.since : Date.now(),
      },
    }))
  else if (e.type === 'spent') update(slug, { usd: e.usd })
  else if (e.type === 'done') {
    update(slug, { usage: e.usage })
    if (e.aborted) patchLast(slug, (t) => said(t, '⏹ stopped'))
  }
  else if (e.type === 'error') {
    patchLast(slug, (t) => said(t, `⚠ ${e.message}`))
  }
}

/** `ask`: the question a card's answer is for (its askId); a typed message names none. */
export async function send(slug: string, message: string, ask?: string): Promise<void> {
  if (get(slug).busy) return
  // Deleted mid-turn (see generations): from then on this turn has nowhere to show.
  const gen = generations.get(slug)
  const forgotten = () => generations.get(slug) !== gen
  // This message answers the question the last turn ended on, whether picked on the card or
  // typed. The server then puts a ✎ note after it rather than before (see the note below).
  const answering = get(slug).turns.some((t) => t.role === 'assistant' && t.ask)
  // The draft is the composer's to clear: a question card sends too, and what was typed
  // below it meanwhile is not part of its answer.
  update(slug, (s) => ({
    busy: true,
    attached: true,
    usage: null,
    activity: { doing: 'waiting', since: Date.now() },
    heard: Date.now(),
    turns: [
      // Answered now, so the card goes, and a turn that only asked with it, as on a reload.
      ...s.turns.map((t) => (t.role === 'assistant' && t.ask ? { ...t, ask: undefined, askId: undefined } : t)).filter(shows),
      { id: fresh(), role: 'user', text: message },
      reply(fresh()),
    ],
  }))

  // Once the server has taken the turn, a stream that ends without `done` or `error` — a laptop
  // asleep, a dropped connection — is this tab losing it, not the turn ending: the turn runs on
  // (see cancel() in agent.ts). The tab watches it then, as after a reload, instead of showing
  // Send for a message the server would refuse with a 409.
  let taken = false
  let told = false
  // A turn another tab runs, found when this one's answer was refused: watched, as after a reload.
  let elsewhere = false
  try {
    const res = await fetch(`/api/projects/${slug}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...(ask && { ask }) }),
    })
    if (!res.ok || !res.body) {
      // Leniently, as api() does: a proxy's 502 is an HTML page, and its parse error said nothing.
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `HTTP ${res.status}`)
    }
    taken = true

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (forgotten()) {
        void reader.cancel().catch(() => {})
        break
      }
      // At most once a second. Every update re-renders the whole chat, and the activity
      // line reads this only on its own one-second tick, so stamping every chunk doubled
      // the renders of a streaming reply for a precision nothing uses.
      const at = Date.now()
      if (at - get(slug).heard >= 1000) update(slug, { heard: at })
      buf += decoder.decode(value, { stream: true })
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        // ': ping' keepalives are comments; every SSE parser drops them.
        if (!frame.startsWith('data: ')) continue
        const e = JSON.parse(frame.slice(6)) as Event
        if (e.type === 'done' || e.type === 'error') told = true
        apply(slug, e, answering)
      }
    }
  } catch (e) {
    // A dropped stream reads as a network error; the turn it lost is not one.
    if ((!taken || told) && !forgotten()) {
      const why = `⚠ ${(e as Error).message}`
      // An answer the server refused took its card with it, and the question may still be open
      // (a turn running, a 503) or answered elsewhere (409): the server's history says which.
      if (!taken && answering) {
        const d = await api<ChatGet>(`/api/projects/${slug}/chat`).catch(() => null)
        if (d) update(slug, { turns: toTurns(d.messages), usage: null })
        elsewhere = !!d?.running
      }
      patchLast(slug, (t) => said(t, why))
    }
  } finally {
    const lost = taken && !told
    // Forgotten, it ends here: a watcher would poll a project that is gone.
    if (!forgotten()) {
      update(slug, { busy: lost || elsewhere, attached: false, activity: null })
      // The watcher settles it, with the history the turn stored.
      if (lost || elsewhere) watch(slug)
      else settledListener?.()
    }
  }
}
