/**
 * The chat as the client keeps it: a stored history rebuilt into turns, the store's own fetches
 * stubbed, the reasoning bubble's helpers, and the scroll pin that follows the bottom.
 */
import { test } from 'bun:test'
import type { ChatEvent } from '../server/stream'
import type { Thought } from '../server/activity'
import { forget, get, load, onSettled, send } from '../src/chatStore'
import { type Reply, type StoredMessage, type Turn, fold, toTurns } from '../src/turns'
import { opening, sizeOf } from '../src/thoughts'
import { type Pin, hold, repin, settle } from '../src/pin'
import { GLM_CHAT, check, folded, noteOf, textOf, thoughtsOf, toolsOf } from './fixtures'

test('the chat as a reload rebuilds it', async () => {
  // Stored history is one assistant message per step. Live, a turn is one bubble with its
  // tool rows; a reload used to show a bubble per step and no rows at all.
  const rebuilt = toTurns([
    { role: 'user', content: '✎ These files were changed outside this chat\nM\tsrc/Home.tsx' },
    { role: 'user', content: 'make it blue' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading it first.' },
      { type: 'tool-call', toolCallId: 'a', toolName: 'check_app', input: { path: '/', viewport: 'mobile', steps: [{}], look: 'q' } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'check_app', output: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ])
  check(rebuilt.length === 3, `reload: note, message, one assistant bubble -> ${rebuilt.length} turns`)
  check(noteOf(rebuilt[0]) && !noteOf(rebuilt[1]), 'reload: the ✎ turn is a note, the message is not')
  check(textOf(rebuilt[2]) === 'Reading it first.\n\nDone.', 'reload: a turn\'s text blocks are paragraphs')
  check(
    JSON.stringify(toolsOf(rebuilt[2])[0]) === JSON.stringify({ id: 'a', name: 'check_app', detail: '/ · mobile · 1 step · look', done: true }),
    'reload: tool rows are rebuilt, with the detail they had live',
  )
  check(thoughtsOf(rebuilt[2]).length === 0, 'reload: a turn that never reasoned has no thoughts')

  // The reasoning comes back per step, raw, as it streamed. GLM's shape: the first step's
  // reasoning text is duplicated into reasoning_details, the second stored `""` beside an
  // encrypted detail, and the last user turn was answered with reasoning and nothing else.
  const reasoned = toTurns(GLM_CHAT)
  check(reasoned.length === 4, `reload: two exchanges, the reasoning folded into them -> ${reasoned.length} turns`)
  check(
    JSON.stringify(thoughtsOf(reasoned[1])) === JSON.stringify(['Plan the canvas.\n\nThen tools.', 'Check it on a phone.']),
    `reload: one raw thought per step that said something, the empty one skipped -> ${JSON.stringify(thoughtsOf(reasoned[1]))}`,
  )
  check(textOf(reasoned[1]) === 'Done.', 'reload: the text is untouched by the reasoning around it')
  check(
    toolsOf(reasoned[1]).map((x) => `${x.name} ${x.detail}`).join(', ') === 'write_file src/Paint.tsx, check_app /',
    'reload: and so are the rows',
  )
  check(
    JSON.stringify(thoughtsOf(reasoned[1]).map((t) => [opening(t), sizeOf(t)])) ===
      '[["Plan the canvas. Then tools.","29"],["Check it on a phone.","20"]]',
    `reload: each step's bubble, its opening words and its size -> ${JSON.stringify(thoughtsOf(reasoned[1]).map((t) => [opening(t), sizeOf(t)]))}`,
  )
  check(
    JSON.stringify((reasoned[1] as Reply).flow) ===
      JSON.stringify([
        { kind: 'thought', text: 'Plan the canvas.\n\nThen tools.' },
        {
          kind: 'tools',
          tools: [
            { id: 'a', name: 'write_file', detail: 'src/Paint.tsx', done: true },
            { id: 'b', name: 'check_app', detail: '/', done: true },
          ],
        },
        { kind: 'thought', text: 'Check it on a phone.' },
        { kind: 'text', text: 'Done.' },
      ]),
    `reload: the turn's flow is its steps in order, the rows of two steps one run where no thinking came between -> ${JSON.stringify((reasoned[1] as Reply).flow)}`,
  )
  // Whole turns, less the id the checks after these cover.
  const unkeyed = (t: Turn | undefined) => t && JSON.stringify({ ...t, id: undefined })
  check(
    unkeyed(reasoned[3]) === JSON.stringify({ role: 'assistant', flow: [{ kind: 'thought', text: 'Because.' }] }),
    `reload: a turn that only reasoned is kept, as it looked live -> ${JSON.stringify(reasoned[3])}`,
  )
  check(reasoned[0]?.role === 'user' && !('flow' in reasoned[0]), 'reload: a user turn has no thoughts')
  const plain = toTurns([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'plain' }])[1]
  check(
    unkeyed(plain) === JSON.stringify({ role: 'assistant', flow: [{ kind: 'text', text: 'plain' }] }),
    `reload: an assistant message stored as a string is text, not a thought -> ${JSON.stringify(plain)}`,
  )
  // <Chat> keys its rows by these, so an id has to name one turn: the same when the history
  // only grew after it, and another where a restore brought back a history that parts from
  // this one. The index alone passes the first and fails the second.
  const ids = (messages: StoredMessage[]) => toTurns(messages).map((t) => t.id)
  const glmIds = ids(GLM_CHAT)
  check(new Set(glmIds).size === glmIds.length, `reload: every turn has an id of its own -> ${JSON.stringify(glmIds)}`)
  check(
    JSON.stringify(ids(GLM_CHAT.slice(0, 6))) === JSON.stringify(glmIds.slice(0, 2)),
    'reload: a turn keeps its id when the history grows after it',
  )
  const parted = ids([...GLM_CHAT.slice(0, 6), { role: 'user', content: 'why not?' }, GLM_CHAT[7]!])
  check(
    parted[1] === glmIds[1] && parted[2] !== glmIds[2] && parted[3] !== glmIds[3],
    `reload: where a restored history parts from this one, the turns after get new ids, an identical reply too -> ${JSON.stringify(parted)}`,
  )
  const streamed = [
    { text: 'Plan the ', fresh: true },
    { text: 'canvas.\n\nThen tools.' },
    { text: 'Check it on a phone.', fresh: true },
  ] satisfies Thought[]
  check(
    JSON.stringify(thoughtsOf(folded(streamed.map((t) => ({ type: 'thought', ...t }))))) === JSON.stringify(thoughtsOf(reasoned[1])),
    'reload: the same turn, streamed, builds the same thoughts',
  )
})

test("a watched turn's end reaches the listing", async () => {
  // A turn started before a reload, or in another tab, is polled, not streamed; its end has to
  // refresh the listing as send()'s does, or a first build that ended watched never slid the
  // preview in. The store's own fetch, stubbed: the chat answers running, then not.
  {
    const realFetch = globalThis.fetch
    let running = true
    globalThis.fetch = (async () =>
      Response.json({ configured: true, defaultModel: '', defaultLookModel: '', running, messages: [] })) as unknown as typeof fetch
    try {
      let heard = 0
      const unheard = onSettled(() => heard++)
      await load('watched')
      check(get('watched').busy && !get('watched').attached, 'a turn this tab did not start is watched')
      running = false
      const until = Date.now() + 5000
      while (get('watched').busy && Date.now() < until) await Bun.sleep(100)
      check(!get('watched').busy && heard === 1, `and its end is heard, as a send's is: the listing refreshes -> ${heard}`)
      unheard()
    } finally {
      globalThis.fetch = realFetch
      forget('watched')
    }
  }
})

test("the counter's live tally, and a delete that outruns the turn", async () => {
  // Each `spent` is the project's tally as book() left it (agent.ts): the workspace counter reads
  // it mid-turn. A delete forgets the project while its turn still streams; what arrives after
  // must not write a state back under the slug, or the next project to take the name shows the
  // deleted one's tally. The store's own fetch, stubbed with a stream this block writes.
  {
    const realFetch = globalThis.fetch
    let out!: ReadableStreamDefaultController<Uint8Array>
    const frame = (e: ChatEvent) => out.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
    globalThis.fetch = (async () => new Response(new ReadableStream({ start: (c) => void (out = c) }))) as unknown as typeof fetch
    try {
      let settled = 0
      const unheard = onSettled(() => settled++)
      const turn = send('spend', 'hi')
      frame({ type: 'spent', usd: 0.5 })
      frame({ type: 'spent', usd: 0.7 })
      const until = Date.now() + 5000
      while (get('spend').usd !== 0.7 && Date.now() < until) await Bun.sleep(10)
      check(get('spend').usd === 0.7 && get('spend').busy, `spent: the counter's tally moves mid-turn -> ${get('spend').usd}`)
      forget('spend')
      frame({ type: 'spent', usd: 0.9 })
      frame({ type: 'done', aborted: true, cost: 0.4, usd: 0.9, model: 'mock', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } })
      out.close()
      await turn
      check(
        get('spend') === get('no-such-project') && settled === 0,
        `a delete mid-turn: what streams after it writes nothing back under the slug -> usd ${get('spend').usd}, busy ${get('spend').busy}, settled ${settled}`,
      )
      unheard()
    } finally {
      globalThis.fetch = realFetch
      forget('spend')
    }
  }
})

test("the client's own ⏹ and ⚠ lines are drawn", async () => {
  // Chat draws the flow, so a line the client adds has to reach it, not `text` alone (review of
  // #46). send() itself, its fetch stubbed: a turn stopped after a row, one that errors after a
  // thought, and one whose POST never got an answer.
  {
    const realFetch = globalThis.fetch
    const streamOf = (...events: ChatEvent[]) =>
      (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
              c.close()
            },
          }),
        )) as unknown as typeof fetch
    const ending = async (slug: string, events: ChatEvent[] | null) => {
      globalThis.fetch = events ? streamOf(...events) : ((async () => Promise.reject(new Error('network down'))) as unknown as typeof fetch)
      await send(slug, 'hi')
      const t = get(slug).turns.at(-1) as Reply
      forget(slug)
      return t
    }
    try {
      const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      const stopped = await ending('lines-stop', [
        { type: 'thought', text: 'Plan.', fresh: true },
        { type: 'tool', id: 'w', name: 'write_file', path: 'src/A.tsx' },
        { type: 'done', aborted: true, cost: 0, usd: 0, model: 'mock', usage },
      ])
      const failed = await ending('lines-error', [{ type: 'thought', text: 'Plan.', fresh: true }, { type: 'error', message: 'OpenRouter 402' }])
      const lost = await ending('lines-lost', null)
      const words = (t: Reply) => JSON.stringify(t.flow.filter((s) => s.kind === 'text').map((s) => s.text))
      check(
        words(stopped) === '["⏹ stopped"]' && stopped.flow.at(-2)?.kind === 'tools' && words(failed) === '["⚠ OpenRouter 402"]' &&
          words(lost) === '["⚠ network down"]',
        `lines: ⏹ and ⚠ are drawn in the flow, after what came before them -> ${[stopped, failed, lost].map(words).join(' ')}`,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  }
})

test('the reasoning as the bubble shows it', async () => {
  const reasoned = (...steps: string[]): Reply => ({ id: 'r', role: 'assistant', flow: steps.map((text) => ({ kind: 'thought', text })) })
  const folds: [Reply, Thought, string[]][] = [
    [reasoned(), { text: 'a', fresh: true }, ['a']],
    [reasoned('a'), { text: 'b' }, ['ab']],
    [reasoned('ab'), { text: 'c', fresh: true }, ['ab', 'c']],
    [reasoned(), { text: 'x' }, ['x']],
  ]
  const misfolds = folds.filter(([r, t, want]) => JSON.stringify(thoughtsOf(fold(r, { type: 'thought', ...t }))) !== JSON.stringify(want))
  check(misfolds.length === 0, `fold: a fresh thought opens a step, any other extends the last${misfolds.length ? ` — not ${JSON.stringify(misfolds)}` : ''}`)
  const was = reasoned('a')
  const now = fold(was, { type: 'thought', text: 'b' })
  check(now.flow !== was.flow && now.flow[0] !== was.flow[0] && thoughtsOf(was)[0] === 'a', 'fold: a new flow and segment every time, so the bubble re-renders')
  const sizes: [string, string][] = [
    ['x'.repeat(812), '812'],
    [`\n ${'x'.repeat(812)} \n`, '812'],
    ['x'.repeat(1500), '1.5k'],
    ['x'.repeat(9950), '10k'],
    ['x'.repeat(26683), '27k'],
  ]
  const misread = sizes.filter(([raw, want]) => sizeOf(raw) !== want).map(([raw]) => sizeOf(raw))
  check(misread.length === 0, `sizeOf: trimmed, exact below 1000, one decimal below 10k, whole k above${misread.length ? ` — got ${misread.join('; ')}` : ''}`)
  const openingOf = opening(`\n  The user wants\n\na board.  ${'word '.repeat(100)}`)
  const astral = opening(`${'x'.repeat(159)}😀y`)
  check(astral.endsWith('x😀') && !/[\uD800-\uDBFF]$/.test(astral), `opening: cut by code point, never half an emoji -> …${astral.slice(-3)}`)
  check(
    openingOf.startsWith('The user wants a board. word') && openingOf.length <= 160 && !openingOf.endsWith(' '),
    `opening: a step's first words, whitespace collapsed, cut to a line's worth -> ${JSON.stringify(openingOf)}`,
  )
})

test('following the bottom', async () => {
  // A 400 px scroller over 1000 px of content, pinned at its bottom.
  const scroll = (scrollTop: number, scrollHeight: number) => ({ scrollTop, scrollHeight, clientHeight: 400 })
  const pinned: Pin = { stuck: true, top: 600 }
  repin(pinned, scroll(700, 1100)) // new content, and our own write follows it down
  const followed = pinned.stuck
  repin(pinned, scroll(680, 1100)) // the reader nudges up one 20 px line
  const nudged = pinned.stuck
  repin(pinned, scroll(690, 1300)) // more arrived meanwhile; they scroll back down, not all the way
  const partWay = pinned.stuck
  repin(pinned, scroll(900, 1300)) // all the way
  check(followed && !nudged && !partWay && pinned.stuck, 'pin: follows its own writes, lets go on one line up, re-pins only at the bottom')
  repin(pinned, scroll(600, 1000)) // a panel above closes, and the browser clamps scrollTop
  check(pinned.stuck, 'pin: a collapse that clamps the scroller up leaves it pinned')
  repin(pinned, scroll(620, 1300)) // the reveal of a panel moved it down, short of the bottom
  const revealed = pinned.stuck
  settle(pinned, scroll(620, 1300))
  check(revealed && !pinned.stuck, 'pin: moving down without reaching the bottom keeps it, and only geometry lets go')
  // A browser fires one scroll event a frame, so a nudge up and our own write in the same
  // frame reach repin as one net move. This box clamps scrollTop the way a browser does:
  // unclamped, the write would record 1040 and the check would pass for the wrong reason.
  const clamped = (top: number, scrollHeight: number) => {
    let t = top
    return {
      get scrollTop() { return t },
      set scrollTop(v: number) { t = Math.max(0, Math.min(v, this.scrollHeight - 400)) },
      scrollHeight,
      clientHeight: 400,
    }
  }
  const same: Pin = { stuck: true, top: 600 }
  const box = clamped(600, 1040)
  hold(same, box) // a send grew the content by 40 px; our write goes to 640
  const wrote = box.scrollTop
  box.scrollTop = 620 // the reader nudges up one line in the same frame
  repin(same, box) // one coalesced scroll event
  check(wrote === 640 && !same.stuck, `pin: a nudge up that shares a frame with our own write still lets go (wrote ${wrote})`)
  const alone: Pin = { stuck: true, top: 600 }
  const grown = clamped(600, 1040)
  hold(alone, grown) // the same growth with nobody scrolling
  repin(alone, grown) // our write's own scroll event
  const idle: Pin = { stuck: false, top: 300 }
  const read = clamped(300, 1040)
  hold(idle, read) // a reader who let go is not moved
  check(
    alone.stuck && grown.scrollTop === 640 && !idle.stuck && read.scrollTop === 300,
    'pin: hold() follows growth while pinned, and leaves a reader who let go where they are',
  )
  // hold() looks before it writes. A browser can apply a move up before it reports one, and
  // a send that lands in between must not take the reader for one still following. Chat's
  // send-time `top: 0` leans on this look as well.
  const early: Pin = { stuck: true, top: 600 }
  const unseen = clamped(600, 1040)
  hold(early, unseen) // a send grew the content by 40 px; our write goes to 640
  unseen.scrollTop = 620 // the reader nudges up a line, and no scroll event has come yet
  unseen.scrollHeight = 1080 // the next send
  hold(early, unseen)
  check(
    unseen.scrollTop === 620 && !early.stuck,
    `pin: a move up the browser has not reported yet still lets go (scrollTop ${unseen.scrollTop})`,
  )
  // scrollTop is fractional at a device pixel ratio of 2 or 3, so the bottom has 2 px of slack.
  const near: Pin = { stuck: false, top: 0 }
  settle(near, scroll(598.5, 1000))
  const halfway = near.stuck
  settle(near, scroll(597, 1000))
  check(halfway && !near.stuck, 'pin: 1.5 px short of the bottom is at it, 3 px short is not')
})


test("a refused answer gives the card back: the chat is reloaded from the server, which knows what is open", async () => {
  const realFetch = globalThis.fetch
  const asked: StoredMessage[] = [
    { role: 'user', content: 'a tip splitter' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'q1', toolName: 'ask_user', input: { questions: [{ question: 'Who for?', header: 'Audience', options: [{ label: 'Me' }], multiSelect: false }] } }] },
  ] as StoredMessage[]
  let posted: unknown
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posted = JSON.parse(String(init.body))
      return Response.json({ error: 'a turn is already running' }, { status: 409 })
    }
    return Response.json({ configured: true, defaultModel: '', defaultLookModel: '', running: false, messages: asked })
  }) as unknown as typeof fetch
  try {
    await load('refused-answer')
    const askId = (get('refused-answer').turns.at(-1) as Reply).askId
    check(askId === 'q1', `the card knows which question it answers -> ${askId}`)
    await send('refused-answer', 'Me', askId)
    check(JSON.stringify(posted) === '{"message":"Me","ask":"q1"}', `and says so -> ${JSON.stringify(posted)}`)
    const last = get('refused-answer').turns.at(-1) as Reply
    check(!!last.ask?.length && JSON.stringify(last.flow).includes('a turn is already running'), 'refused: the card is back, and why it was refused is said')
  } finally {
    globalThis.fetch = realFetch
    forget('refused-answer')
  }
})

test("an answer refused because another tab's turn runs: this tab watches that turn, as after a reload", async () => {
  const realFetch = globalThis.fetch
  let running = false
  const asked = [
    { role: 'user', content: 'a tip splitter' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'q1', toolName: 'ask_user', input: { questions: [] } }] },
  ]
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) =>
    init?.method === 'POST'
      ? Response.json({ error: 'a turn is already running for "elsewhere"' }, { status: 409 })
      : Response.json({ configured: true, defaultModel: '', defaultLookModel: '', running, messages: asked })) as unknown as typeof fetch
  try {
    await load('elsewhere')
    running = true
    await send('elsewhere', 'Me', 'q1')
    check(get('elsewhere').busy, "the other tab's turn shows as running here: no Send for a message it would refuse")
    running = false
    const until = Date.now() + 5000
    while (get('elsewhere').busy && Date.now() < until) await Bun.sleep(100)
    check(!get('elsewhere').busy, 'and its end is seen')
  } finally {
    globalThis.fetch = realFetch
    forget('elsewhere')
  }
})
