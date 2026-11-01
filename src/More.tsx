import { useCallback, useEffect, useState } from 'react'
import { settingsPatch } from '../shared/settings'
import Harness from './Harness'
import SettingsSection from './Settings'
import { type House, type Project, type Settings, type SettingsChange, api, json } from './api'
import { load } from './chatStore'
import { useChat } from './hooks'
import { GearIcon, ListChecksIcon } from './icons'

/**
 * Where More's sections read their settings and send a change: a project, which saves each
 * change as it is made, or the start page's draft, which holds them until the create takes
 * them along. The sections do not know which, beyond `kind` for their wording.
 */
export type Target = {
  kind: 'project' | 'draft'
  settings: Settings
  /** Applies a change. Rejects with the reason it was refused, in the server's words either way. */
  save: (change: SettingsChange) => Promise<void>
  /** The house default model and describer: what a project with none of its own runs on. '' until known. */
  house: string
  houseLooker: string
  /** Asks for the house defaults again, when the last ask failed. */
  askHouse: () => void
  /** A turn is running, so a change applies from the next message. */
  busy: boolean
  /** The chat has history, so a model switch re-reads it uncached. */
  talked: boolean
}

/** More's sections, in the list's order. */
const MORE = {
  settings: { label: 'Settings', Glyph: GearIcon },
  harness: { label: 'Harness', Glyph: ListChecksIcon },
} as const

export type Section = keyof typeof MORE

/**
 * More: the sections down the left, the one chosen beside them. The workspace's pane over a
 * project, and the start page's sheet over its draft.
 *
 * Lovable's shape — where the box is wide enough, by the box's width and not the window's: at
 * a 768 window, or with the chat dragged wide, a 208 px list left Settings 78 px (measured), a
 * word a line and the knobs' fields cut off. Narrower, the list is a row above the section. The
 * flex is on a box inside the container, not on it: a container query styles only what is
 * inside.
 */
export default function More({
  target,
  section,
  onSection,
}: {
  target: Target
  section: Section
  onSection: (s: Section) => void
}) {
  return (
    <div className="@container h-full overflow-hidden rounded-xl border border-current/10 bg-paper">
      <div className="flex h-full flex-col @xl:flex-row">
        <nav
          aria-label="More"
          className="flex shrink-0 gap-1 border-b border-current/10 p-2 @xl:w-52 @xl:flex-col @xl:border-b-0 @xl:border-r"
        >
          {(Object.keys(MORE) as Section[]).map((k) => {
            const { label, Glyph } = MORE[k]
            return (
              <button
                key={k}
                type="button"
                aria-current={section === k ? 'page' : undefined}
                onClick={() => onSection(k)}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm @xl:min-h-0 ${
                  section === k ? 'bg-current/10 font-medium' : 'opacity-70 hover:bg-current/5 hover:opacity-100'
                }`}
              >
                <Glyph className="size-4 opacity-70" />
                {label}
              </button>
            )
          })}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
          {section === 'settings' ? <SettingsSection target={target} /> : <Harness target={target} />}
        </div>
      </div>
    </div>
  )
}

/** The workspace's More, over its project. The chat's state is read here, not handed down:
 *  the pane is not under the chat. */
export function ProjectMore({
  project,
  onChange,
  section,
  onSection,
}: {
  project: Project
  onChange: () => void
  section: Section
  onSection: (s: Section) => void
}) {
  const slug = project.slug
  const { defaultModel, defaultLookModel, busy, turns } = useChat(slug)
  // The house defaults come with the chat's history. When that fetch failed, nothing asks
  // again until the chat remounts — so showing the pane does.
  const askHouse = useCallback(() => void load(slug), [slug])
  const target: Target = {
    kind: 'project',
    settings: project,
    save: async (change) => {
      try {
        await json(`/api/projects/${slug}`, 'PATCH', change)
      } finally {
        // After a refusal too: the panel shows what is stored, not what was tried.
        onChange()
      }
    },
    house: defaultModel,
    houseLooker: defaultLookModel,
    askHouse,
    busy,
    talked: turns.length > 0,
  }
  return <More target={target} section={section} onSection={onSection} />
}

/** Per browser, like the theme: the start page's last choices, which the next one starts from. */
const DRAFT_KEY = 'ab-start-settings'

/**
 * The start page's settings, before there is a project to save them to: held here, sent with
 * the create, and kept in this browser for the next start page. A change goes through
 * settingsPatch as a PATCH would, so the draft refuses what the server would, in its words,
 * and the stored draft is read back through it too — a value this build no longer takes is
 * dropped here rather than refused at the create.
 */
export function useDraft(): Target {
  const [settings, setSettings] = useState<Settings>(readDraft)
  const [house, setHouse] = useState({ model: '', looker: '' })
  // A failure leaves '' — Settings says the house default has not loaded, and asks again.
  const askHouse = useCallback(() => {
    api<House>('/api/house').then(
      (h) => setHouse({ model: h.defaultModel, looker: h.defaultLookModel }),
      () => {},
    )
  }, [])
  useEffect(askHouse, [askHouse])
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(settings))
    } catch {
      // Private window or blocked storage: the draft still works, it is just not kept.
    }
  }, [settings])
  return {
    kind: 'draft',
    settings,
    save: async (change) => {
      const apply = settingsPatch(change)
      // A function of the draft as it is when it runs, so two quick changes both land.
      if (apply) setSettings((s) => ({ ...s, ...apply(s) }))
    },
    house: house.model,
    houseLooker: house.looker,
    askHouse,
    busy: false,
    talked: false,
  }
}

function readDraft(): Settings {
  try {
    return settingsPatch(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null'))?.({}) ?? {}
  } catch {
    return {}
  }
}
