/**
 * What a control in a header bar looks like. Strings, not components: every caller needs
 * to add its own layout to them, and a component that took `className` for that would be
 * the same string with a wrapper around it.
 *
 * Written once, because what was wrong with the workspace bar was six buttons that all
 * looked alike: the segmented groups have to stay identical to each other and distinct
 * from the bare actions, and that only holds while there is a single copy of each rule.
 * The theme group is on all three screens, and the settings use it too — so the copy lives
 * here rather than in the file that happened to need it first. The pane chips are the one
 * group that does not: they are Lovable's pill, which slides (Chips.tsx).
 *
 * No display utility in GROUP, so each caller writes its own beside it — `flex` today, with
 * any hiding done by a parent (the form factors sit in a `hidden md:flex` column). One baked
 * in here would, the day a caller hid its group, land in the same class list as that
 * `hidden` and leave Tailwind's output order to settle which one wins — the trap `stage` in
 * Workspace.tsx is written out longhand to avoid.
 */
export const GROUP = 'shrink-0 items-center gap-0.5 rounded-lg bg-current/5 p-0.5'

/** The segment in force. */
export const ON = 'bg-current/10'

/** The segments that are not, which is the whole of how a group reads as a choice. */
export const OFF = 'opacity-50 hover:opacity-100'

/** A bare action — no well, or it would read as one more segmented group. */
export const ACTION = 'shrink-0 rounded-lg p-1.5 opacity-50 hover:opacity-100 hover:bg-current/5'

/** A segment's size, in a group whose buttons are words: the theme's and the form factors' are icons. */
export const SEGMENT = 'rounded-md px-2.5 py-2 md:py-1 text-sm'

/** The action a card is for, on ink: Use this one, Approve. 44 px tall on a phone, the tap-target floor. */
export const PILL = 'min-h-11 rounded-full bg-ink px-3 text-sm font-medium text-paper disabled:opacity-50 md:min-h-9'

/** The card's other actions, beside a PILL. */
export const OUTLINE = 'min-h-11 rounded-full border border-current/25 px-3 text-sm hover:border-current/50 disabled:opacity-50 md:min-h-9'

/** A card at the end of the chat that waits on the person: a question, the design picker, DESIGN.md. */
export const CARD = 'space-y-3 rounded-xl border border-blue-500/30 bg-blue-500/[0.04] p-3'

/** One choice of several, the whole tile the label of its radio or checkbox; blue while chosen. */
export const tile = (on: boolean) =>
  `flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 has-focus-visible:outline-2 has-focus-visible:outline-current/40 ${
    on ? 'border-blue-500/60 bg-blue-500/10' : 'border-current/15 hover:border-current/35'
  }`

/** What a part of the Artefacts pane is called: Who it is for, Colours. */
export const LABEL = 'text-xs font-medium uppercase tracking-wide opacity-60'

/** What a group of settings is called, quieter than LABEL: they sit closer together. */
export const LEGEND = 'text-xs font-medium uppercase tracking-wider opacity-40'

/** One of a row of steps or examples, blue while it is the one shown: Ask's questions, the design viewer's examples. */
export const chip = (on: boolean) =>
  `min-h-11 rounded-full px-3 text-sm md:min-h-8 ${
    on ? 'bg-blue-500/15 text-blue-700 ring-1 ring-inset ring-blue-500/35 dark:text-blue-300' : 'opacity-70 hover:opacity-100'
  }`

/** A text field in the settings: the model search and a knob's value. */
export const INPUT =
  'rounded-md border border-current/15 bg-transparent px-2 py-1.5 text-base md:text-sm font-mono outline-none focus:border-current/40'
