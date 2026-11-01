import { useEffect, useLayoutEffect, useRef } from 'react'
import { defaultKeymap, history, historyField, historyKeymap } from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { HighlightStyle, syntaxHighlighting, type LanguageSupport } from '@codemirror/language'
import { EditorState, type Range, StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap, lineNumbers } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { lineDiff } from '../shared/diff'

/**
 * The editor half of the code pane. Loaded lazily from Files.tsx: CodeMirror plus four
 * grammars is a few hundred KB, the tab is opt-in, and the preview is the hot path.
 *
 * Editing is ⌘S / Ctrl-S only — no autosave, no conflict UI; whether the buffer differs
 * from the disk goes up through onDirty, for the mark on its tab. The server owns the
 * conflict story: it refuses a write while a turn is running and refuses one whose token
 * has moved, and both refusals land in the banner Files.tsx already renders. The undo
 * story is the checkpoint the save makes.
 */

/**
 * A tab's editor while another file is on screen: its text, selection and undo history as
 * JSON, the disk content that text is based on, and where it was scrolled. Files keeps one
 * per open tab. JSON rather than the EditorState itself, because a state carries its
 * extensions, and this keymap's ⌘S would still call the save of the mount that built it.
 */
export type Parked = { json: unknown; base: string; scroll: StateEffect<unknown> }

/**
 * Colours come from CSS custom properties, not from a JS theme object, so the dark
 * variant flips on the same `data-theme` attribute as the rest of the app — no theme
 * prop threaded down to here, no second CodeMirror theme to keep in sync, and nothing
 * for this component to subscribe to. Their values live in src/app.css; what writes the
 * attribute is src/theme.ts.
 *
 * It used to be a prefers-color-scheme query, and these were the only colours in the app
 * that query actually reached — so an OS in light mode painted the light syntax palette
 * onto a page that was permanently dark. See the private design log.
 */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: 'var(--cm-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--cm-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--cm-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--cm-function)' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: 'var(--cm-def)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--cm-type)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--cm-tag)' },
  { tag: [t.attributeName, t.propertyName], color: 'var(--cm-attr)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--cm-punct)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--color-ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: '14px',
    lineHeight: '1.65',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'color-mix(in oklch, var(--color-ink) 30%, transparent)',
  },
  // The caret is the browser's own: with no drawSelection() there is no .cm-cursor to
  // style, and CM6's base theme only lifts the caret off black under `&dark` — which this
  // theme is not, since EditorView.theme() defaults to light. So it painted black on the
  // dark background and was invisible. One property, flipping with the text's own variable.
  '.cm-content': { padding: '0.5rem 0', caretColor: 'var(--color-ink)' },
  // The chat's diff colours (ToolRow): see-through, so one value reads on paper and on ink.
  '.cm-added': { backgroundColor: 'rgb(34 197 94 / 0.15)' },
  // .cm-line's own padding, so the removed text lines up with the text around it.
  '.cm-removed': { backgroundColor: 'rgb(239 68 68 / 0.15)', padding: '0 2px 0 6px', whiteSpace: 'pre-wrap' },
})

/**
 * What the newest turn changed in the file, over its text: the lines it added on green, the
 * lines it removed in a red block where they were — read-only, and skipped by the line numbers.
 * Against `was`, what the turn found before its first change to the file (GET /file), so a tab
 * the turn opened (Files follows the agent) shows it as well as one that was on screen, and
 * every change of the turn shows, not only its last. Typing moves the colours with the text.
 */
const colour = StateEffect.define<string | null>()

class Removed extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: Removed) {
    return other.text === this.text
  }
  toDOM() {
    const el = document.createElement('div')
    el.className = 'cm-removed'
    el.textContent = this.text
    return el
  }
}

const added = Decoration.line({ class: 'cm-added' })

function paint(was: string, doc: Text): DecorationSet {
  const marks: Range<Decoration>[] = []
  let gone: string[] = []
  const removed = (at: number, side: number) => {
    if (gone.length) marks.push(Decoration.widget({ widget: new Removed(gone.join('\n')), block: true, side }).range(at))
    gone = []
  }
  for (const l of lineDiff(was, doc.toString())) {
    if (l.t === '-') {
      gone.push(l.s)
      continue
    }
    const line = doc.line(l.n)
    removed(line.from, -1)
    if (l.t === '+') marks.push(added.range(line.from))
  }
  removed(doc.length, 1)
  return Decoration.set(marks, true)
}

const changes = StateField.define<{ was: string | null; deco: DecorationSet }>({
  create: () => ({ was: null, deco: Decoration.none }),
  update(c, tr) {
    for (const e of tr.effects) if (e.is(colour)) return { was: e.value, deco: e.value === null ? Decoration.none : paint(e.value, tr.state.doc) }
    // ⌘Z takes back a turn's change as one change of the whole text, which mapping cannot
    // follow: it piled every colour onto line 1. So an undo or a redo is painted afresh.
    if (c.was !== null && (tr.isUserEvent('undo') || tr.isUserEvent('redo'))) return { ...c, deco: paint(c.was, tr.state.doc) }
    return tr.docChanged ? { ...c, deco: c.deco.map(tr.changes) } : c
  },
  provide: (f) => EditorView.decorations.from(f, (c) => c.deco),
})

/** The first thing the turn changed, in the middle of the view — when it changed anything. */
function toChange(v: EditorView) {
  const first = v.state.field(changes).deco.iter()
  if (first.value) v.dispatch({ effects: EditorView.scrollIntoView(first.from, { y: 'center' }) })
}

function languageFor(path: string): LanguageSupport | null {
  switch (path.slice(path.lastIndexOf('.') + 1).toLowerCase()) {
    case 'ts':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'jsx':
      return javascript({ jsx: true })
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'css':
      return css()
    case 'html':
    case 'svg':
      return html()
    case 'json':
      return json()
    default:
      // Plain text still gets line numbers and wrapping, which is the useful part.
      return null
  }
}

export default function CodeView({
  path,
  content,
  was,
  parked,
  onSave,
  onDirty,
}: {
  path: string
  content: string
  /** The file before the newest turn changed it, when it did: its changes are coloured. */
  was?: string
  parked: Map<string, Parked>
  onSave: (content: string) => void
  onDirty: (dirty: boolean) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  /** What the disk holds, as far as this buffer knows: the last read, or the last save. */
  const base = useRef(content)
  /** What the last ⌘S sent, so its own echo coming back is not taken for someone's write. */
  const sent = useRef<string | null>(null)
  /**
   * Opened afresh rather than from a parked editor, and not yet taken to what the turn changed.
   * Read at the first render: StrictMode's rehearsal unmount parks the editor before the real
   * mount, which then looked parked and stayed at the top (seen on dev).
   */
  const opened = useRef(!parked.has(path))
  /** Through refs so the mount effect's deps stay empty and the view is built once. */
  const save = useRef(onSave)
  save.current = onSave
  const dirty = useRef(onDirty)
  dirty.current = onDirty
  const report = (state: EditorState) => dirty.current(state.doc.toString() !== base.current)

  // One file per mount: Files keys this on the path, and parks the editor between tabs.
  // A layout effect for the cleanup's sake — a passive cleanup runs once the DOM is
  // already gone, and a detached scroller reports scrollTop 0.
  useLayoutEffect(() => {
    const parent = host.current
    if (!parent) return
    const extensions = [
      lineNumbers(),
      EditorView.lineWrapping,
      // history() and defaultKeymap are not optional once the doc is editable: without
      // them CM6 has no Enter, no Tab and no undo — it is a textarea that eats keys.
      history(),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: (v) => {
            sent.current = v.state.doc.toString()
            save.current(sent.current)
            return true
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) report(u.state)
      }),
      syntaxHighlighting(highlight),
      changes,
      theme,
      languageFor(path) ?? [],
    ]
    const kept = parked.get(path)
    const v = new EditorView({
      parent,
      state: kept
        ? EditorState.fromJSON(kept.json, { extensions }, { history: historyField })
        : EditorState.create({ doc: content, extensions }),
      scrollTo: kept?.scroll,
    })
    if (kept) base.current = kept.base
    view.current = v
    // Block body, and the return is a function on purpose. A concise body here would
    // hand React whatever the last expression evaluated to — see the private design log.
    return () => {
      parked.set(path, {
        json: v.state.toJSON({ history: historyField }),
        base: base.current,
        scroll: v.scrollSnapshot(),
      })
      v.destroy()
      view.current = null
    }
    // Mount once; the effect below carries every later read of this file.
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v) return
    // Painted with the text it is about, in one transaction, and again whenever `was` moves:
    // on a mount (a parked tab's colours are not parked), as a turn starts, and on a save.
    const painted = colour.of(was ?? null)
    if (content === base.current) {
      v.dispatch({ effects: painted })
      // A tab opened afresh opens at what the turn changed; a parked one where it was left. A
      // frame later, on the editor that stays: a scroll asked of the rehearsal's is parked as 0.
      if (opened.current)
        requestAnimationFrame(() => {
          if (opened.current && view.current) toChange(view.current)
          opened.current = false
        })
      return
    }
    opened.current = false
    base.current = content
    // Our own save coming back, or a read that already matches the buffer — a save that
    // landed while the tab was parked — only moves the base. Replacing the text then put
    // the cursor back on line 1 after every ⌘S, and threw away anything typed while the
    // save was in flight. Anything else is the disk changing under the buffer, an agent
    // turn, and the disk wins; as one change, so ⌘Z still brings the unsaved text back.
    const doc = v.state.doc.toString()
    if (content !== doc && content !== sent.current) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content }, effects: painted })
      // Following the agent: to where its change landed, which may be far from where you were.
      toChange(v)
    } else v.dispatch({ effects: painted })
    report(v.state)
  }, [content, was])

  return <div ref={host} className="flex-1 min-h-0 overflow-hidden" />
}
