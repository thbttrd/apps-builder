import { useId, useState } from 'react'
import { slugify } from '../shared/slug'
import ThemeToggle from './ThemeToggle'
import type { Project } from './api'
import { ago } from './format'

export default function Projects({
  projects,
  busy,
  error,
  version,
  onAbout,
  onOpen,
  onNew,
  onDelete,
}: {
  projects: Project[]
  busy: boolean
  error: string | null
  /** null until /api/version answers, and for good if it never does. */
  version: string | null
  onAbout: () => void
  onOpen: (slug: string) => void
  /** Opens the start page, with the name typed here, or '' to have it named from the prompt. */
  onNew: (name: string) => void
  onDelete: (slug: string) => void
}) {
  const [query, setQuery] = useState('')
  const hint = useId()

  // One field searches and creates, so the text is read one way for both: as the slug the
  // server would make of what Create sends — trimmed, both here and there, since a leading
  // space costs slugify one of its 40 characters. That is what Create would make, and what a
  // search now looks for: "My Todo" finds my-todo-app, which the raw text never did. A name
  // is taken when its slug is in the listing, which is the server's 409 as of the last
  // refresh — a project made or deleted in another tab since shows up at the next one.
  const name = query.trim()
  const slug = slugify(name)
  const taken = projects.some((p) => p.slug === slug)
  /** Something typed that makes no slug: '!!!', or a name in a script slugify drops. */
  const nameless = name !== '' && slug === ''
  /** Why Create is off, said under the field; '' when it is not. */
  const refusal = taken
    ? `“${slug}” already exists.`
    : nameless
      ? 'A name needs a letter or a digit (a–z, 0–9).'
      : ''
  // Recency, not the server's alphabetical order: this screen is "what was I last doing".
  const shown = projects
    .filter((p) => p.slug.includes(slug))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))

  return (
    <div className="h-dvh overflow-y-auto bg-paper text-ink">
      <header className="sticky top-0 z-10 bg-paper/85 backdrop-blur border-b border-current/10">
        <div className="mx-auto max-w-6xl px-4 md:px-8 py-3 flex items-baseline gap-2">
          <h1 className="font-semibold tracking-tight text-sm opacity-70">apps-builder</h1>
          {/* The version is the way in to About, because a number with no explanation
              behind it is the thing people screenshot and ask about. It degrades to the
              word when the fetch failed — the screen is then the only place that says
              why, so it must stay reachable. */}
          <button
            onClick={onAbout}
            title="version, changelog, and what this instance is running"
            className="rounded-md px-1.5 py-0.5 font-mono text-xs opacity-40 hover:opacity-100 hover:bg-current/5"
          >
            {version ?? 'About'}
          </button>
          <div className="flex-1" />
          {/* `self-center` because the row is `items-baseline` — which is what keeps the
              version chip sitting on the wordmark's baseline, and which a group of icons
              with no text in it would otherwise hang off the bottom of. */}
          <ThemeToggle className="flex self-center" />
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 md:px-8 py-6 md:py-10">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">Projects</h2>

        {/*
          One field, where there used to be a search and a Create that opened a second field
          for the name: the search looked like the place to name a new project, and was not.
          A form, so Enter creates as the button does, and a search input, whose ✕ and
          Escape clear it in Chrome and Safari. `enterKeyHint`, because a phone labels a
          search field's Enter "Search", and here Enter makes a project. The field is never
          disabled: disabling it would drop the focus.

          Create opens the start page, which asks what to build; the project is made there,
          from the prompt. So Create works with the field empty — the prompt names the project
          then — and a name typed here is the one it gets.
        */}
        <form
          className="mt-5 md:mt-6 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (taken || nameless) return
            onNew(name)
          }}
        >
          <input
            type="search"
            aria-label="search or create a project"
            aria-describedby={refusal ? hint : undefined}
            enterKeyHint="go"
            className="min-w-0 flex-1 rounded-xl border border-current/15 bg-transparent px-3.5 py-2.5 text-base md:text-sm outline-none focus:border-current/40"
            // Short, because at 320 px "Search or create a project…" was cut to "…a proj";
            // the aria-label has the whole of it.
            placeholder="Search or create…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="rounded-xl bg-ink text-paper px-4 py-2.5 text-sm shrink-0 aria-disabled:opacity-40"
            // aria-disabled, never disabled: a button that becomes disabled under the focus
            // drops it to <body> — a name typed into it that turns out taken, for one. onSubmit
            // refuses both.
            aria-disabled={taken || nameless}
            title={slug ? (taken ? `“${slug}” already exists` : `create “${slug}”`) : 'start a new project'}
          >
            Create
          </button>
        </form>
        {/* Said, not just a greyed button: the server's refusal used to say why, and the
            button's title is out of reach on a phone. Always rendered, as a status, so a
            screen reader says it as it changes — aria-describedby is read only on focus, and
            a region that mounts with its text in it is often not announced at all. */}
        <p id={hint} role="status" className={refusal ? 'mt-2 px-1 text-sm opacity-60' : undefined}>
          {refusal}
        </p>

        {/* An alert, since the focus now stays on Create through a failure: nothing else
            would say that it failed. */}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-500">
            {error}
          </p>
        )}

        {/* A taken name always shows its own card, so here the name is free: say so. */}
        {shown.length === 0 ? (
          <p className="mt-16 text-center text-sm opacity-50">
            {projects.length === 0
              ? 'No projects yet. Press Create to start one.'
              : `Nothing matches “${query.trim()}”. Press Create to make it.`}
          </p>
        ) : (
          <ul className="mt-6 grid gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <li key={p.slug} className="group">
                {/* The thumbnail opens it too, for a pointer: an overlay, not a wrapper, since a
                    <button> may not contain an <iframe>. Not a second control: the name below is
                    the one a keyboard and a screen reader reach. */}
                <div className="relative aspect-16/10 overflow-hidden rounded-2xl border border-current/10 bg-current/5 transition group-hover:border-current/30">
                  {!p.built ? (
                    /* Before its first build a project's preview is the template, running or
                       photographed: the one thing not to show as what the project is. */
                    <div className="absolute inset-0 grid place-items-center bg-linear-to-br from-sky-400/15 via-fuchsia-400/10 to-orange-400/15">
                      <span className="text-xs opacity-50">not built yet</span>
                    </div>
                  ) : p.running && p.url ? (
                    /*
                      A running project's card is the running app itself: free, and always
                      current. A stopped one falls through to the last frame recordShot()
                      wrote — see "Preview screenshots" in the private design log. (This comment used
                      to say there was no screenshotter, eight lines above the branch that
                      renders one.) Three times the card's size scaled back to a third lays
                      the app out at a desktop width — a card-width viewport would render
                      its phone layout instead.
                    */
                    <iframe
                      src={p.url}
                      title={`${p.slug} preview`}
                      tabIndex={-1}
                      loading="lazy"
                      className="absolute left-0 top-0 w-[300%] h-[300%] origin-top-left scale-[0.3333] pointer-events-none border-0 bg-white"
                    />
                  ) : p.shotAt ? (
                    /* Stopped, but it has been photographed: show what it looked like the
                       last time it ran. The dot below is what says it is not live now. */
                    <img
                      src={`/api/projects/${p.slug}/screenshot?v=${encodeURIComponent(p.shotAt)}`}
                      alt=""
                      className="absolute inset-0 w-full h-full object-cover object-top"
                    />
                  ) : (
                    <div className="absolute inset-0 grid place-items-center bg-linear-to-br from-emerald-400/10 via-transparent to-sky-400/15">
                      <span className="text-xs opacity-40">never run</span>
                    </div>
                  )}
                  <div aria-hidden className="absolute inset-0 cursor-pointer" onClick={() => onOpen(p.slug)} />
                </div>

                <div className="mt-3 flex items-start gap-2">
                  <span
                    aria-hidden
                    className={`mt-1.5 size-1.5 rounded-full shrink-0 ${p.running ? 'bg-emerald-500' : 'bg-current/25'}`}
                    title={p.running ? `running on :${p.port}` : 'stopped'}
                  />
                  <div className="flex-1 min-w-0">
                    <button
                      className="block max-w-full truncate text-sm font-medium hover:underline"
                      onClick={() => onOpen(p.slug)}
                      aria-label={`open ${p.slug}`}
                    >
                      {p.slug}
                    </button>
                    <p className="text-xs opacity-50">
                      {/* The dot's colour, in words. */}
                      <span className="sr-only">{p.running ? 'Running. ' : 'Stopped. '}</span>
                      Edited {ago(p.updatedAt)} · {p.turns} turn{p.turns === 1 ? '' : 's'}
                    </p>
                  </div>
                  <button
                    aria-label={`delete ${p.slug}`}
                    title="delete project"
                    className="-mt-1 px-2 py-1 text-sm opacity-40 md:opacity-0 md:group-hover:opacity-40 hover:!opacity-100 hover:text-red-500 disabled:opacity-20"
                    disabled={busy}
                    onClick={() => onDelete(p.slug)}
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
