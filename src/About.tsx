import ThemeToggle from './ThemeToggle'
import { type VersionInfo } from './api'
import { ago } from './format'

/**
 * The third screen, on the same terms as the other two: it takes the whole window and
 * `‹ Projects` is the way back. A modal would have been the app's first, for a page whose
 * content is paragraphs.
 *
 * Everything on it is fetched, never compiled in. The point of the screen is to answer
 * "what is actually deployed here", and a constant baked into the bundle answers "what
 * was deployed when this bundle was built", which is a different question on every
 * instance that has ever been debugged.
 */
export default function About({
  info,
  error,
  onBack,
}: {
  info: VersionInfo | null
  error: string | null
  onBack: () => void
}) {
  const exact = info !== null && info.describe === `v${info.version}`
  const qualifier = info && state(info.version, info.describe)

  return (
    <div className="h-dvh overflow-y-auto bg-paper text-ink">
      <header className="sticky top-0 z-10 bg-paper/85 backdrop-blur border-b border-current/10">
        <div className="mx-auto max-w-3xl px-4 md:px-8 py-3 flex items-center gap-2">
          <button
            onClick={onBack}
            className="-ml-2 rounded-lg px-2 py-1 text-sm opacity-70 hover:opacity-100 hover:bg-current/5"
          >
            ‹ Projects
          </button>
          <div className="flex-1" />
          <ThemeToggle className="flex" />
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 md:px-8 py-6 md:py-10">
        {error && <p className="text-sm text-red-500">{error}</p>}
        {!info && !error && <p className="text-sm opacity-50">…</p>}

        {info && (
          <>
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
              apps-builder <span className="font-mono opacity-60">{info.version}</span>
            </h2>
            <p className="mt-2 text-xs opacity-50">
              {qualifier && <>{qualifier} · </>}
              <span className="font-mono" title={info.sha}>
                {info.sha.slice(0, 7)}
              </span>
              {' · started '}
              {ago(info.startedAt)}
            </p>
            {info.description && (
              <p className="mt-4 text-sm opacity-70 max-w-prose">{info.description}</p>
            )}

            <ol className="mt-10 md:mt-12 space-y-10">
              {/* An entry with nothing under it is `[Unreleased]` at a release commit —
                  which is every staging deploy, and printing a bare heading for it would
                  make the newest thing on the page the one that says nothing. */}
              {info.entries
                .filter((e) => e.sections.length > 0)
                .map((e) => (
                  <li key={e.version ?? 'unreleased'} className="md:grid md:grid-cols-[8rem_1fr] md:gap-8">
                    <div className="md:text-right">
                      <h3 className="text-sm font-medium font-mono">{e.version ?? 'Unreleased'}</h3>
                      <p className="mt-0.5 text-xs opacity-45">
                        {e.date ?? 'in this tree'}
                      </p>
                      {/* Only on an exact match. One commit past the tag and this instance
                          is no longer that release, and the line above already says so. */}
                      {exact && e.version === info.version && (
                        <span className="mt-1.5 inline-block rounded-md bg-emerald-500 text-white px-1.5 py-0.5 text-[11px] font-medium">
                          deployed here
                        </span>
                      )}
                    </div>

                    <div className="mt-3 md:mt-0 space-y-4">
                      {e.sections.map((s, i) => (
                        <div key={i} className="space-y-2">
                          {s.title && (
                            <h4 className="text-[11px] font-medium uppercase tracking-wider opacity-40">
                              {s.title}
                            </h4>
                          )}
                          {s.blocks.map((b, j) =>
                            b.kind === 'list' ? (
                              <ul key={j} className="list-disc pl-4 space-y-1.5 marker:opacity-25">
                                {b.items.map((item, k) => (
                                  <li key={k} className="text-sm leading-relaxed">
                                    {inline(item)}
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p key={j} className="text-sm leading-relaxed opacity-75">
                                {inline(b.text)}
                              </p>
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * What `git describe` says, in words. The version on its own would claim a release that a
 * tree twelve commits past it has not made — and the dev instance is permanently that
 * tree, so the qualifier is the normal case rather than an edge one.
 */
function state(version: string, describe: string | null): string | null {
  if (!describe) return null
  const dirty = describe.endsWith('-dirty')
  const tag = dirty ? describe.slice(0, -'-dirty'.length) : describe
  const ahead = /^v(.+)-(\d+)-g[0-9a-f]+$/.exec(tag)
  const said = ahead
    ? `${ahead[2]} commit${ahead[2] === '1' ? '' : 's'} past v${ahead[1]}`
    : tag === `v${version}`
      ? 'tagged release'
      : // A sha with no tag behind it (`--always`), or a tag that is not the declared
        // version. Both are odd enough to be worth showing raw rather than summarised.
        tag
  return dirty ? `${said}, uncommitted changes` : said
}

/**
 * `code` and **bold**, which is all the entries use. Split keeps the separators because
 * the pattern is one capture group. Links are deliberately not supported: the only ones
 * in the file are in the preamble, which never reaches this screen.
 */
function inline(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('`') ? (
      <code key={i} className="rounded bg-current/8 px-1 py-0.5 font-mono text-[0.85em]">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith('**') ? (
      <strong key={i} className="font-medium">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  )
}
