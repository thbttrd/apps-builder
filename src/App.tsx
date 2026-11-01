import { useCallback, useEffect, useRef, useState } from 'react'
import About from './About'
import Projects from './Projects'
import Start from './Start'
import Workspace from './Workspace'
import { api, json, type Project, type VersionInfo } from './api'
import { forget, onSettled, send } from './chatStore'

/**
 * Screens, not panes. The project list is where you land; opening a project
 * replaces it, so the workspace gets the whole window — a permanent sidebar listing the
 * projects you are not working on costs the preview its width on every viewport.
 *
 * Create goes by way of the start page, which asks what to build: the project is made from
 * that prompt, and the workspace opens on it already sent.
 *
 * About is one more on the same terms rather than the app's first modal. Its data is
 * fetched here because the header's version chip needs the number anyway, so opening the
 * screen costs nothing and a failed fetch is still reportable on the screen itself.
 */
export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  /** The start page, with the name typed on the projects screen ('' for none); null when shut. */
  const [start, setStart] = useState<{ name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [about, setAbout] = useState(false)
  const [version, setVersion] = useState<VersionInfo | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)

  /**
   * The listing is asked for after every action, at every turn's end, and after each write of a
   * first build, so two can be in flight: only the newest asked may land. An older one answered
   * after it put back what was no longer so — built: false while the first build slid in.
   */
  const asked = useRef(0)
  const refresh = useCallback(() => {
    const n = ++asked.current
    return api<Project[]>('/api/projects')
      .then((ps) => {
        if (n === asked.current) setProjects(ps)
      })
      .catch((e: Error) => {
        if (n === asked.current) setError(e.message)
      })
  }, [])
  // Every turn's end, sent from here or only watched: the workspace learns of the first build
  // from the listing (see onSettled).
  useEffect(() => onSettled(() => void refresh()), [refresh])

  useEffect(() => {
    // The preview cookie must exist before any iframe loads, or every one of them 401s
    // at Traefik. This origin is behind SSO, so reaching it is the authorisation.
    api('/api/session', { method: 'POST' })
      .catch((e: Error) => setError(e.message))
      .then(refresh)
  }, [refresh])

  // Separate from the session bootstrap above: nothing else waits on it, and a version
  // this cannot read must not take the project listing down with it.
  useEffect(() => {
    api<VersionInfo>('/api/version')
      .then(setVersion)
      .catch((e: Error) => setVersionError(e.message))
  }, [])

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true)
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  // A selected slug the listing does not have means the project is gone — deleted in
  // another tab, or the listing has not arrived yet. Either way, the list is what to show.
  const current = projects.find((p) => p.slug === selected)

  if (about) {
    return <About info={version} error={versionError} onBack={() => setAbout(false)} />
  }

  if (start) {
    return (
      <Start
        name={start.name}
        busy={busy}
        error={error}
        onBack={() => {
          setStart(null)
          setError(null)
        }}
        onStart={(prompt, settings) =>
          void act(() =>
            // Both, and the server lets a typed name win: the prompt names the project only when
            // nobody did. The settings are More's on the start page, which the project is made
            // with, so its first turn already runs on them.
            json<Project>('/api/projects', 'POST', {
              ...(start.name ? { name: start.name, prompt } : { prompt }),
              ...(Object.keys(settings).length ? { settings } : {}),
            }).then((p) => {
              // Seed the listing in the same tick as the selection: refresh() lands a
              // render later, and a slug the listing has never heard of bounces straight
              // back to the projects screen.
              setProjects((ps) => (ps.some((x) => x.slug === p.slug) ? ps : [p, ...ps]))
              setSelected(p.slug)
              setStart(null)
              // From here, not from the chat: the store is per slug and outlives the
              // component, and a send before the chat's load() is safe — load() sees the
              // turn busy and leaves it alone. Its end refreshes the listing (onSettled above).
              void send(p.slug, prompt)
              return p
            }),
          )
        }
      />
    )
  }

  if (!current) {
    return (
      <Projects
        projects={projects}
        busy={busy}
        error={error}
        version={version?.version ?? null}
        onAbout={() => setAbout(true)}
        onOpen={setSelected}
        onNew={(name) => {
          setError(null)
          setStart({ name })
        }}
        onDelete={(slug) => {
          if (!confirm(`Delete "${slug}" and everything in it?`)) return
          forget(slug)
          // api(), not fetch(): fetch resolves for a 404 or a 500, so act()'s catch never
          // ran and a failed delete cleared the error banner and reported success — while
          // forget() had already thrown that project's chat state away.
          void act(() => api(`/api/projects/${slug}`, { method: 'DELETE' }))
        }}
      />
    )
  }

  return (
    <Workspace
      project={current}
      busy={busy}
      error={error}
      onBack={() => setSelected(null)}
      onChange={(nextSlug) => {
        // Only when it really moved. A rename whose name re-slugifies to the same slug
        // returns that slug, and <Chat key={slug}> does not remount — so forgetting it
        // would blank a live conversation that nothing can bring back.
        if (nextSlug && nextSlug !== current.slug) {
          // The directory moved, so the history now lives under the new slug — and the
          // listing is patched alongside the selection for the same reason as create.
          forget(current.slug)
          setProjects((ps) =>
            ps.map((p) => (p.slug === current.slug ? { ...p, slug: nextSlug } : p)),
          )
          setSelected(nextSlug)
        }
        void refresh()
      }}
      onStart={() => void act(() => api(`/api/projects/${current.slug}/start`, { method: 'POST' }))}
      onStop={() => void act(() => api(`/api/projects/${current.slug}/stop`, { method: 'POST' }))}
    />
  )
}
