/**
 * A project, pushed into its preview's pod. The pod's /app starts empty and the
 * pod reaches nothing: apps-builder pushes the source to the control port (preview-control.mjs), then
 * every change — a tool's write, an editor save, a restore — as it lands. Nothing comes back: the pod's
 * copy is never read, so what the model's code does to it never reaches the files git and tsc run on.
 *
 * Each push is what differs from the last state the pod acknowledged (path → sha1), found by rescanning
 * the tree: a rescan costs a few ms on a project (node_modules, .git, .apps-builder and dist are never
 * read), and catches renames and deletes that a watcher's per-path events describe badly. The watcher
 * only says when; flush() rescans at once, so a write made just before it is never missed for a late
 * event.
 */
import { createHash } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EXCLUDED } from './preview-control.mjs'

export type Sync = {
  /** Resolves once the pod holds every file as the disk had it when flush() was called. */
  flush(): Promise<void>
  stop(): void
}

const DEBOUNCE_MS = 25
/** A push the pod never answers — on the cluster a deleted pod's address just goes silent — fails here,
 *  rather than holding the preview's start, stop, rename and delete forever. */
const PUSH_DEADLINE_MS = 60_000
/** A push that failed in the background is sent again after this, without waiting for another edit. */
const RETRY_MS = 1000
/** base64 characters per push, well under the control port's 32 MiB. */
const BATCH = 16 * 1024 * 1024
/** A file whose base64 is over this fits no push (with its JSON, under 32 MiB): it is left out, or the
 *  control port's 413 would refuse every later push with it. ~18 MB of file. */
const MAX_FILE = 24 * 1024 * 1024

/** Resolves after the initial push has its 204; rejects with the pod's answer when it does not.
 *  `deadlineMs` is for the tests. */
export async function startSync(dir: string, control: string, token: string, deadlineMs = PUSH_DEADLINE_MS): Promise<Sync> {
  const acked = new Map<string, string>()
  /** path → sha already said too large, so the log says it once per version. */
  const skipped = new Map<string, string>()
  let chain: Promise<void> = Promise.resolve()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const pushDiff = async () => {
    const now = await tree(dir)
    const changed: [string, Buffer, string][] = []
    for (const [path, data] of now) {
      const sha = createHash('sha1').update(data).digest('hex')
      if (acked.get(path) !== sha) changed.push([path, data, sha])
    }
    const gone = [...acked.keys()].filter((path) => !now.has(path))
    let files: Record<string, string | null> = Object.fromEntries(gone.map((path) => [path, null]))
    let size = 0
    let shas = new Map<string, string | null>(gone.map((path) => [path, null]))
    const send = async () => {
      if (!shas.size) return
      const r = await fetch(`${control}/_ab/push`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(deadlineMs),
      })
      if (r.status !== 204) throw new Error(`the preview refused a push: ${r.status} ${await r.text()}`)
      for (const [path, sha] of shas) {
        if (sha === null) acked.delete(path)
        else acked.set(path, sha)
      }
      files = {}
      shas = new Map()
      size = 0
    }
    for (const [path, data, sha] of changed) {
      const encoded = data.toString('base64')
      if (encoded.length > MAX_FILE) {
        if (skipped.get(path) !== sha) console.error(`[sync ${dir}] ${path} is too large for the preview (${data.length} bytes): left out`)
        skipped.set(path, sha)
        continue
      }
      if (size + encoded.length > BATCH) await send()
      files[path] = encoded
      shas.set(path, sha)
      size += encoded.length
    }
    await send()
  }
  // One push at a time; a failed one leaves `acked` as it was, and a rescan RETRY_MS later sends it again.
  const run = () => (chain = chain.catch(() => {}).then(() => (stopped ? undefined : pushDiff())))
  const kick = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => void run().catch(retry), ms)
  }
  const retry = (e: unknown) => {
    console.error(`[sync ${dir}]`, (e as Error).message)
    if (!stopped) kick(RETRY_MS)
  }

  const watcher: FSWatcher = watch(dir, { recursive: true }, (_event, name) => {
    if (name && EXCLUDED.includes(String(name).split('/')[0] ?? '')) return
    kick(DEBOUNCE_MS)
  })
  const stop = () => {
    stopped = true
    clearTimeout(timer)
    watcher.close()
  }
  try {
    await run()
  } catch (e) {
    stop()
    throw e
  }
  return {
    flush: () =>
      run().catch((e) => {
        if (!stopped) kick(RETRY_MS)
        throw e
      }),
    stop,
  }
}

/** Every file of the project the pod gets, by path: no symlink, nothing under an excluded name. */
async function tree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (!rel && EXCLUDED.includes(e.name)) continue
      if (e.isDirectory()) await walk(path)
      else if (e.isFile()) out.set(path, await readFile(join(dir, path)))
    }
  }
  await walk('')
  return out
}
