# Changelog

One entry per released version, newest first. Entries are written *before* the release:
`bun run release <major|minor|patch|X.Y.Z>` promotes `[Unreleased]` to a numbered section,
bumps `package.json` to match, and tags the commit `vX.Y.Z` with this entry as the tag's
annotation. Staging deploys the highest `v*` tag on origin, so the newest numbered section
below is what the author's staging instance is running.

`[Unreleased]` is what is in the tree and not yet tagged — always empty at a release
commit, which is why the staging instance never shows it and the dev instance usually does.

Versions are [semver](https://semver.org/spec/v2.0.0.html). While the product is pre-1.0:
**minor** is a visible feature or behaviour change, **patch** is fixes only, and **major**
is reserved for 1.0. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.27.0] — 2026-10-23

### Added

- **Stop a preview.** The green dot beside a project's name now stops its preview. Staging runs eight
  previews at most, and starting a ninth asks you to stop one: this is how.
- **Previews nobody uses stop on their own** after 30 minutes: no tab or gallery card showing them, no
  turn running, nothing through them. Start, or the agent's next check, brings one back.
- **A crashed app shows its error instead of a blank page,** in the preview and in its gallery picture,
  and the error goes away once the app is fixed.
- **Once a design is approved, the agent's checks hold the app to it.** A colour or font that isn't one
  of the design's is reported, with the nearest one of the design's, and the agent fixes it before
  saying it's done (or changes the design's colour, when you asked for a new look).

### Changed

- **When the agent can't start the preview to check its work, it now says why**, so it can tell you
  when the reason is yours to act on (staging's eight previews are all running).
- **The browser the agent checks your app in can live in a separate, sandboxed place.**
  `AB_BROWSER_CDP` may now name a host (it is looked up first: Chrome only answers to an address), so
  staging can run that browser away from apps-builder itself.
- **The default model is always served at full precision** (fp8 or better). Two in three of its
  requests went to cheaper 4-bit providers, below the quality it was chosen for; a request now costs
  about $0.009 instead of $0.0065.
- **Claude models are sent their earlier reasoning again**, which costs less: dropping it made each new
  message re-write the conversation's cache, at 5–10 times what it saved.

### Fixed

- **The Artefacts pane no longer goes blank on a spec or plan it can't read.** A file broken by hand, or
  saved in another shape by an older version, now reads as no spec or no plan; before, the whole page
  disappeared, or the pane's request failed.
- **The agent can click things whose names contain quotes**, such as a checkbox labelled Mark "Learn
  React" as done. It used to retry them until it ran out of steps.
- **Gallery pictures wait their turn in the browser**, as the agent's checks do, so many turns ending at
  once can't open more pages than it holds.
- **The design examples' check sees more of a page's colours**: text shadows, SVG gradients and icons,
  checkbox and progress colours. An example could use off-design colours there unnoticed.
- **A preview whose node goes down no longer blocks its project** until the node is back, when the app
  has no database: its pod is removed by force after the usual wait. An app with a database still waits
  for its node (its data is there), and the message now says which node.
- **When the cluster can't start a preview, the message says why** (for example, no node has the memory
  for it), and a refusal for lack of room for an app's database is no longer replaced by another error.
- **Deleting an app whose database can't be removed now keeps the app**, so it can be deleted again,
  instead of leaving its data behind with nothing pointing at it.
- **A question card left open in another tab can no longer answer a newer question.** Its answer is
  refused, and the chat shows where things are.
- **An answer that fails to send no longer makes the question disappear.** The card comes back with
  the reason it failed.
- **A release whose rollout fails no longer leaves staging down.** The release job now undoes it: the
  previous version comes back, the failed version is skipped, and the alert says so. Before, staging
  stayed down and the job tried the same version again every minute until someone stopped it.

### Security

- **An app's page can no longer act on the UI's API.** A preview is same-site with the UI, so a page an
  app shows could send requests to the API with your sign-in: start a turn (and spend), restore or
  create a project. Writes now come from apps-builder's own pages only; anything else is refused (403).

## [0.26.1] — 2026-10-22

### Changed

- **The first release the cluster's job deploys.** No change to the app: this release runs the new
  release job once, end to end — both images built, tested and pushed, pinned in the cluster's GitOps repo, rolled out.

## [0.26.0] — 2026-10-22

### Added

- **Previews on the cluster.** With `AB_PREVIEW_NAMESPACE` set, a preview is a gVisor pod in that
  namespace, made over the Kubernetes API (`server/kube.ts`), its databases on a volume of their own
  that a rename does not touch; `AB_PREVIEW_IMAGE` names the preview image and `AB_BROWSER_CDP` the
  browser the screenshots use. A start the namespace's quota refuses says so (503).
- **apps-builder's own image** (`deploy/Dockerfile`, Chromium beside it) and `deploy/build-images.sh`,
  which builds, tests and pushes both images.

### Changed

- **Staging runs on the cluster.** A release tag now builds and tests both images, pushes them to
  the image registry and pins them by digest in the cluster's GitOps repo, whose Flux deploys them. This is the last release the dev server's staging unit receives.

## [0.25.0] — 2026-10-21

### Changed

- **A preview's files are pushed into it.** Its pod no longer mounts the project: it starts with an
  empty /app, and apps-builder pushes the source in through a port of the pod's own, then every change
  as it lands. Nothing the app's code writes in its pod reaches the project apps-builder runs git and
  tsc in. node_modules comes from a preview image (`deploy/preview.Dockerfile`), so a project whose
  lockfile is not the template's is refused at start, saying why.
- **`/_ab/fetch` goes out over a line apps-builder holds into the pod**, a long-poll, instead of a
  socket the pod mounted: same answers, same rules, at most 8 at once per preview.
- **An app's server restarts within about a second of an edit**, from a loop, not `bun --watch`.
- **apps-builder's own origin header is `x-ab-origin`**, which the proxy stamps beside `x-origin-auth`
  (that one becomes the cluster Gateway's). The dispatcher asks for the preview cookie itself, and
  neither header nor the preview cookie reaches the app.
- **Screenshots are taken by the same browser check_app drives**, which can be another process's,
  over CDP (`AB_BROWSER_CDP`).

### Fixed

- **Each preview has an /app of its own.** podman turned the pods' `app` emptyDir into one volume
  shared by every running preview; it is named after the pod now.

## [0.24.0] — 2026-10-09

### Changed

- **A new app's preview slides in while its first build is still running.** It used to wait for
  the end of the build, so the app appeared finished. It now slides in as soon as the build's
  home page can be shown — the template's rewritten, or replaced by a page of the app's own, and
  the parts it uses written too — and the rest of the build lands in it as you watch, in a tab
  that is only watching the build too. The template itself is still never shown, and nor is an
  error in the app's place: writes before that page — a name, a helper file — do not bring the
  preview in. If you are reading Artefacts or More when it comes, you stay there, and the Preview
  chip blinks until you open it.

### Fixed

- **The preview no longer reloads after every step of a turn.** Each step's save of the
  conversation reloaded the page in the preview, and whatever you were doing in the app with it.
  It now only takes the changes the turn makes.
- **A build that renamed the app without making its home page no longer shows the template.**
  Stopped early, or ending its first step on the colours and the name, a build showed the
  template's page under the new name. The chat stays alone until the app's own page is there.
- **A turn that fails part-way keeps what it wrote.** Its files were left out of History, and
  the next turn was told someone else had changed them. They are now its own, as "turn N
  (failed)", the way a stopped turn's are.

## [0.23.0] — 2026-10-07

### Changed

- **The design card shows each design in the colours its example starts from.** The five
  colours beside a design under "Which of these designs is closest" were picked apart from the
  colours the example is then built in, so for a third of the designs the card showed colours the
  example would not have. They are now the example's own: its background, surface, text, main
  colour and accent.

### Fixed

- **Two messages sent at once no longer start two builds.** A double-click on Send, or the same
  project open in two tabs, could start a second turn over the first, leaving the first one
  impossible to stop and both writing the same files. The second is now refused.
- **Restoring, renaming or saving a file waits for nothing to be running.** Each of these could
  start in the instant a turn was starting, and land in the middle of its writes. The other way
  round too: a message sent while one of them ran built on the project as it was before it — in
  a renamed project's old folder, or over a restored conversation.
- **A design rule that starts with a number keeps it.** "1.25rem padding inside every card" was
  read as a numbered item and saved as "25rem padding inside every card".
- **"Use this one" in the design viewer can't be pressed twice.** A second tap while the pick was
  on its way answered with an error.
- **Stop and restore say when they fail.** A Stop that did not reach the server did nothing,
  silently. A restore whose conversation did not reload showed the old conversation and reported
  success; it now says the conversation on screen is out of date. An error page from a proxy
  shows its status instead of a parse error.
- **A new app's page is titled "New app"**, as its header says, instead of "app" — what a
  browser tab shows for a preview opened on its own, until a design names it.
- **Clearer to a screen reader and a keyboard.** A project on the projects screen is one stop for
  Tab, not two, and says whether it is running, which only its dot's tooltip did. The design
  viewer's examples say which one is shown. The model field Settings falls back to has a name, and
  the start page's "Starts with" says when it can't be opened.

## [0.22.0] — 2026-10-07

### Added

- **See what each file change did, as in Claude Code.** In the chat, a "write file" or "edit
  file" row opens on a click to show what it changed: the removed lines on red, the added lines
  on green, numbered as in the file, with three unchanged lines around each change. It shows the
  same after a reload. Rows written before this version have no diff to show, and say so.
- **The code pane shows the newest turn's changes, and follows the builder.** While the code
  pane is open, the file the builder just wrote comes up in it, scrolled to the change, unless
  the file you have open there has unsaved changes. What the newest turn changed in a file is
  coloured the same way: added lines on green, removed lines in a red block where they were.
  The colours stay until the next turn starts or you save that file yourself. The first build
  is not coloured: every file in it is new.

## [0.21.0] — 2026-10-06

### Changed

- **The plan you're asked to approve is a formatted list.** It used to arrive as one long
  paragraph in the question, and your answer repeated all of it. Now the chat shows the plan
  as the Artefacts tab does — a title and a numbered row per step with its contract under it —
  with a one-sentence question under it, and your answer is one line. Approving the whole
  plan frames no single step; "After each step" frames the step it asks about. The plan stays
  in the chat after you answer.
- **The builder's thinking sits where it happened.** Each step's thinking is a bubble labelled
  "thinking", placed before what that step said and the files it wrote, instead of all of it
  in one card at the end of the reply. A bubble shows the step's opening words and size, and
  opens on its own; the step it is thinking in reads "thinking…" with its last lines live.

## [0.20.1] — 2026-10-05

### Fixed

- **"After each step" no longer lets a build skip ahead to done.** A builder that marked several
  steps done at once — or finished a plan you had never seen — used to wrap up without asking.
  It now checks the app, then asks whether the result is what you wanted. With "Once, for the
  whole plan", a step added and finished in one go is put to you the same way.
- **A build's closing summary costs less.** It reuses the conversation already cached instead of
  reading all of it again — about $0.03 less per finished plan with the house model.

## [0.20.0] — 2026-10-05

### Added

- **Apps can have a server and a database.** When an app's data has to be shared between
  people or devices — a guestbook everyone signs, a list on the phone and the laptop — the
  builder gives it a server and Redis or Postgres, beside the preview and as shut in as it. It
  asks first when the request leaves that open. Apps that don't need one stay as they were.

### Security

- **Each app's preview runs in its own sandbox.** An app's code now runs in a container of its
  own, with no network — not the internet, not the local network, not the server, not another
  app — and none of apps-builder's secrets. An app's server can read the app's files but not
  change them. The preview, its live reload and fetching other sites through
  `/_ab/fetch` work as before; opening a preview takes about half a second longer.
- **The builder can no longer get code run on the server.** Three kinds of project file —
  Vite's config, a PostCSS config, and a module a stylesheet loads through Tailwind — are run
  by the preview on the server, not in the browser. The preview no longer reads a PostCSS
  config, and the builder can no longer write the other two.

## [0.19.0] — 2026-09-30

### Changed

- **The spend counter moves while the builder works.** It used to sit still for the whole of
  a message, however long — six minutes at $0 — and jump when it ended. It now goes up after
  every request the builder makes, by what that request cost. A message cut off by a server
  restart now still counts what it had spent; it used to count nothing.

## [0.18.0] — 2026-09-30

### Added

- **A record of every step the builder takes.** Each project now keeps a log of every
  request the builder makes — what it cost, how long it took, which provider answered, what
  each tool did and whether it was refused — and of every message, with how it ended. It is
  for finding out, across all projects, what works and what does not. It stays with the
  project, and a restore does not undo it.

## [0.17.0] — 2026-09-30

### Added

- **Thinking window, in More › Settings.** How much one reply may be, reasoning included. By
  default the largest the model's providers offer, kept to half its context so the
  conversation keeps the other half; smaller values are a click away. It also chooses the
  provider: only those that can write that much are used, the cheapest of them first, so a
  cheap provider with a small limit no longer cuts the builder short.

- **Smaller steps, and faster building.** The builder plans in smaller steps: a big app, like
  a game or a 3D scene, starts with a simple version on screen, and each later step adds one
  thing. It writes a file as soon as it knows its first version rather than planning every
  file first. And while it builds a step it has already planned, it thinks less than while
  planning: with Claude at the highest Thinking, the fox animation that used to think for ten
  minutes and write nothing now writes its first files in two.
- **The builder can change part of a file.** It used to rewrite a whole file for every
  change, even a single colour. Now it edits just the lines that change, so small changes
  are quicker, and on a big file it can write a first version and grow it rather than plan
  every line before writing any.

### Changed

- **One message now builds until it has spent $2, not for 24 steps.** 24 steps were about
  $0.30 of building on the house model and $1.50 on Claude, and a bigger app needed
  “continue” again and again. A new setting, *Spend per message* in More › Harness — $0.50,
  $1, $2 (the default) or $5 — sets how much one message may spend; once it has, the builder
  stops with a ⚠ note saying what it spent, and “continue” gives it as much again. On GLM,
  $2 is up to 100 steps; on Claude Sonnet, about 30.

### Fixed

- **The builder can use its whole output room.** A reply was capped at 65,536 tokens when the
  model could write 128,000 (Claude Sonnet among them), so at a high Thinking setting the
  builder could spend all of it thinking and stop before it wrote anything. It now gets the
  model's full limit (see Thinking window).
- **A turn cut off at that limit says so.** Instead of ending silently after its thinking, it
  ends with a ⚠ note saying the builder ran out of room, and what to do: lower Thinking, raise
  the Thinking window, or ask for a smaller piece. The note stays in the chat.
- **A turn cut off in the middle of writing a file no longer breaks the chat.** The file it
  was about to write is reported as not written, and the next message goes through; it used
  to fail every message after it until a restore.
- **Editing works with GLM.** On the house model, the builder's changes to more than one line
  kept failing — the provider it is routed to cut them short — so it rewrote whole files or
  ran out of steps trying. It now sends each change on its own, and they land.
- **A message that stops partway says so.** A build that used all one message may do used to
  stop without a word, halfway, and look stuck. It now ends with a ⚠ note: send “continue”
  and it picks up where it left off.
- **A build waiting for your go stops instead of writing on.** When the plan was waiting for
  your answer and the builder kept trying to write anyway, every refused write was a paid
  step, to the end of the message. It now stops after the second, and asks you to say “go”.
- **A restart mid-build keeps what was done.** The conversation is saved after every step,
  so a restart or a provider error loses one step instead of the whole message, and
  reloading the page mid-build shows how far it has got.
- **A dropped connection no longer strands the chat.** If the connection dropped while the
  builder was working — a laptop put to sleep — the chat showed Send while the build ran on,
  and sending said a turn was already running. It now keeps following the build and shows
  the result when it ends.
- **Claude Opus with Thinking off stays off while it builds.** Building a planned step turned
  its reasoning on at medium, billed as output, while the settings said off.

## [0.16.0] — 2026-09-29

### Added

- **Tabs in the code view.** A file you pick from the list opens in a tab above the code, as
  in an editor, and picking one that is already open switches to it. × closes a tab and the
  one beside it takes its place; with many open, the tabs scroll sideways. Each tab keeps
  what you typed, where you were in the file and what ⌘Z can undo while you look at
  another. A tab with unsaved changes shows ● and asks before it closes. If the builder
  rewrites a file you have unsaved changes in, its version is shown, and ⌘Z brings yours
  back.

### Fixed

- **Saving no longer sends the cursor to the top.** After typing and pressing ⌘S, the
  cursor jumped back to the first line.
- **Saving and switching to another file straight away works.** The code view could go
  blank until the builder next changed something, and saving the second file while the
  first was still saving did nothing.

## [0.15.1] — 2026-09-29

### Fixed

- **Scrolling over the message box no longer slides the whole workspace up.** While the
  builder was thinking, or before the first build with a long plan, a scroll over the box
  you type in moved the chat and the box off the top of the screen and left empty space
  under the header. Opening the thinking panel mid-turn nudged it up the same way.

## [0.15.0] — 2026-09-28

### Added

- **More on the start page.** The page that asks "What should we build?" now has a More
  button, with the same Settings and Harness as a project's. Pick the model, its parameters
  and when the builder stops for you before the project exists, and it is made with them:
  its first turn already runs on them. A line under the box says what the project will start
  with, and this browser remembers your choices for the next one.
- **Propose a design first**, a new switch in More › Harness. With it on, a new app gets
  design questions before anything is planned or built: its mood, light or dark, how much
  fits on a screen, and which of four designs from a catalog of 61 is closest to the look
  you want, each shown with its colours. The builder can add up to two questions of its
  own. Your answers are kept as a design brief in Artefacts, and the build follows them.
- **Three designs to pick from.** After the design questions, the builder draws your app's
  main screen three times, each in a different design: the one you chose and two others
  suited to your answers. Each is checked before you see it: its colours and fonts must
  be the design's own, it must fit a phone and a desktop, and it must show your app with
  real content. One that fails three times is left out. Pick from pictures at the end of
  the chat, or open one full size in Artefacts, on a phone's width or a desktop's. Use this
  one builds the app in that design; say what to change instead, and the builder redraws
  the ones you mean.
- **Your design, written down and approved.** Once you pick a design, the builder writes it
  down as a DESIGN.md: its colours, fonts, type sizes, corners, spacing and components, read
  off the page you picked, then what each is for in your app and how it lays out on a
  phone, a tablet and a desktop, with the do's and don'ts. Read it in Artefacts, say what to
  change, or go back to the examples. Approve it, and the app is set up in that design
  before anything is built, so the first version you see is already in it.

### Changed

- **New apps are styled from design tokens.** A new project's colours, fonts and corners
  live in one place, `src/app.css`, and its frame uses them, so changing the look is changing
  those. It looks the same as before.

## [0.14.0] — 2026-09-27

### Changed

- **History is a list, newest on top.** Each version is one row: what changed, when, and
  Restore on the left (or "current", for the version you are on), and the version's picture
  on the right, large enough to recognise it and no longer covered by a badge.
  It used to be a grid of cards, which you had to read left to right to find the newest.

## [0.13.0] — 2026-09-27

### Changed

- **A new project starts with a question, not a blank app.** Create now opens a page that
  asks "What should we build?"; what you type there is the project's first message, and the
  project is named from it, unless you typed a name on the projects screen. While the
  builder asks its questions and plans, the chat has the whole window. The preview slides in
  beside it when the first build is done, not before: until then the only app there was the
  empty template. Artefacts and More stay within reach the whole time.
- **History starts at the first build.** The template and the turns before the first build,
  whose pictures were all the empty template, are no longer listed. A project card on the
  projects screen says "not built yet" until then.
- **The first build is a first version of your app.** When the builder works in steps, step 1
  is now the main screen doing its main job, not the template under a new name.
- **Accents keep their letters in a project's name.** "Café crème" makes `cafe-creme`, where
  it used to make `caf-cr-me`.

## [0.12.0] — 2026-09-27

### Added

- **Apps can read other websites.** A feed reader, a weather card or anything else that loads
  data from another site now works in the preview: every app has its own relay on its own
  address, so the browser's cross-site rule no longer gets in the way, and the builder is
  told to use it instead of public proxies that break. It reaches public sites only, never
  your own network. This includes apps built before today, with nothing to redo.

### Fixed

- **The builder no longer tells you a broken download works.** Its own checks could not load
  other sites and called such failures harmless. They now go through the same relay, so it
  checks with real data, and a request that would fail for you is flagged for it to fix.

## [0.11.0] — 2026-09-26

### Changed

- **Apps get a layout for each device, not one that merely fits.** A new app starts in a
  frame that looks different on each: a top bar and tabs at the bottom on a phone, a rail of
  icons on a tablet, a sidebar on a desktop. The builder is told to design each screen three
  times — two panes on a tablet, sidebars, columns and grids on a desktop — and to keep empty
  and first-run screens inside that layout rather than a lone card in the middle of the window.
  Panes side by side scroll on their own, so a long list no longer carries its detail away.
  It checks every new screen on all three.
- **The spec says how each device is laid out.** Artefacts shows a phone, a tablet and a
  desktop line under Design, so you can correct the layout before the build starts.
- **The builder is told when a desktop screen is a phone layout.** A screen whose content fills
  less than half the width at tablet or desktop size fails the builder's check as NARROW,
  naming the element that holds it in, and the builder fixes it before saying it is done —
  unless you asked for a centred layout, which it keeps, telling you the check flags it.

## [0.10.0] — 2026-09-26

### Added

- **The builder asks before it guesses.** When a request leaves product decisions open — who
  the app is for, what its main screen does — the builder stops and asks, with a card of
  options in the chat, one question at a time with a review of your picks before you send.
  Or type your own answer in the box below; the build carries on from there. A question
  waiting for you survives a reload.
- **An Artefacts tab, with the app's spec.** Once its questions are answered, the builder
  writes down what it is about to build — who the app is for and what each of them wants, how
  it looks, its screens, the edge cases it must handle — and the new Artefacts chip shows it.
  It updates as the builder saves it, and restoring a snapshot brings back the spec that went
  with it.
- **The build goes step by step, and you choose when it stops.** Before writing code the
  builder lays out its plan — a few steps, each with its contract: what it does, what changes,
  how it will be checked — and Artefacts shows each step as not started, in progress or done,
  above the spec. More › Harness sets when it stops for you: before each step, with that
  step's contract and a Go, or once, to approve the whole plan. A new plan — a first one, or
  a feature added to a finished one — is always put to you.

### Changed

- **The builder runs on GLM-5.3 by default.** Its flash sibling lost track of multi-step
  builds — re-reading files, asking questions the spec already answered. GLM-5.3 finishes
  them. It cannot see images, so screenshots it asks about are described by GLM-5.3-flash;
  More › Settings shows both. Each step costs more, about $0.20 on a mid-sized app.
- **Requests keep to one provider**, picked by price, so more of each request is read from
  that provider's cache.
- **Each request of a long build is smaller.** The builder no longer sends its own past
  reasoning back to the model — about half the input on the long build it was measured on.
  It is still shown in each turn's thinking panel.

### Fixed

- **The builder no longer asks you to start the preview.** When it checks its work and the
  preview is stopped, it starts it itself.
- **No stray blank lines in the builder's reply while it is still writing it.**

## [0.9.0] — 2026-09-25

### Changed

- **Chips pick the pane.** Over the preview, Preview, Code, History and More are chips — an
  icon each, the name only on the one you are on — under a pill that slides to whichever you
  pick. Away from the preview, the bar names the pane you are in and an ✕ on its right takes
  you back. On a phone, tapping a chip also takes you to its pane, and the back button no
  longer steps between the chat and the preview: it leaves the app, as on every other screen.
- **The model settings moved from the chat to More › Settings.** The chat is the conversation
  and nothing else; the model, the screenshot describer, thinking and every sampling knob are
  in the new More pane, under Settings, and work as before.
- **One field searches and creates.** The projects screen has a single *Search or create…*
  field: typing filters the projects, and Create makes one from what you typed —
  enabled only when no project has that name yet, which the field says when one does. Search
  now also finds `my-todo-app` from "my todo".

## [0.8.0] — 2026-09-25

### Added

- **A settings panel per project.** The model line above the chat opens into the project's
  settings: pick any OpenRouter model that can use tools (each marked *images* or *text only*,
  with its price and context size), choose how hard it thinks — or whether it thinks at all,
  where the model lets you — and tune every sampling knob it accepts: temperature, top-p,
  top-k, min-p, top-a, the three penalties, seed. Each setting explains what it does and what
  changes as it goes up or down, shows the model's own default, and resets on its own; one
  button resets them all. Only the options the chosen model really takes are shown, and
  switching to a model drops the settings it does not take. Changes save as you make them and
  apply from the next message.
- **Text-only models can still check how the page looks.** Picking a model that cannot see
  images proposes one that can, which describes the app's screenshots in words for it.

### Changed

- **The workspace is easier to read.** The chat takes about a third of the window instead of
  a fixed narrow strip, replies are larger plain text, your messages sit in bubbles, what the
  model did and how it reasoned sit in small cards, and the message box is larger with a round
  send button. Nothing in the chat or the settings is smaller than 14 px any more, apart from
  small labels. History and the code view got the same larger text.
- **Drag the chat's edge to make it wider or narrower.** The width is remembered in this
  browser; double-click the edge to go back to the default. From the keyboard, focus the edge
  and use the arrow keys. History and the code view fit whatever width the chat leaves them.
- Changing a project's settings no longer adds an "edit" entry to its history.

### Fixed

- **Confirming a word with Enter in a Japanese or Chinese input method no longer sends your
  message half-written**, as a paid turn. Enter still sends once the word is in.

## [0.7.1] — 2026-09-24

### Fixed

- **apps-builder answers only requests that came through the sign-in.** Its ports were
  reachable from any container on the two servers and from any VPN device without ever
  passing the SSO proxy, and anything that reached them could list projects, run code, and
  collect the preview cookie. Every port now refuses a request that lacks the secret header
  the SSO proxy (and Traefik, for previews) adds after sign-in, and refuses everything while that
  secret is not configured. The preview cookie was rotated, so an open tab needs one reload.

## [0.7.0] — 2026-09-24

### Added

- **You can read everything the builder thought, while it thinks and afterwards.** Tap the
  three-line thinking box and it opens into a panel of the whole reasoning, up to half the
  screen, that keeps up with new text as it arrives. It never grows taller than the chat,
  so on a phone held sideways it opens whole, newest line in view, and the chat keeps
  following. Scroll up in it to read and it stays put. Scroll back to the bottom and it
  follows again. Only its header, or Escape from inside the panel, closes it, so a tap to
  stop a scroll or a long-press to select can't shut it on you. When the turn ends, the
  reasoning stays in the reply as one line, `thinking · 4 steps · 1.4k chars`, which opens
  onto every step in order. It comes back exactly the same after a reload, except for what
  was never saved: a step cut off by Stop is missing, and a turn that failed on the server,
  or was stopped before its first step finished, is gone entirely, your message with it.

### Fixed

- **Scrolling up in the chat while the builder works no longer pulls you back down.** The
  chat used to jump to the bottom whenever anything arrived, up to four times a second
  while the model reasons. It now follows only while you are at the bottom, and pressing
  send takes you there. Opening the ✎ note about files you changed outside the chat no
  longer pulls you away from it either.
- **A restore no longer opens a ✎ note you hadn't opened.** After a turn that failed, or
  was stopped before it got going, a code + chat restore could pass an open note's state to
  the note that took its place in the list.
- **The sliver of a cut-off line above the thinking box**, seen on a Mac, should be gone.
  The box's top edge now fades only once the box is full, so a short thought stays crisp.
  This has not yet been checked on a Mac.

## [0.6.0] — 2026-09-23

### Added

- **The chat shows what the builder is doing while it works.** A turn could sit silent for
  minutes: one paint-app request spent 3½ minutes reasoning before its first word, and the
  chat showed nothing the whole time. The live reply now ends in a line with a pulsing orb:
  `waiting for the model`, `thinking` with the latest few lines of its reasoning scrolling
  underneath, `writing`, `running check_app / · mobile`, `saving`, plus how long it has
  been doing that. The orb is tied to the connection, not to a timer. It pulses while the
  server is still reaching the browser, which it does at least every 15 s even when the
  model is quiet. After 35 s with nothing at all, it turns amber and says the connection
  may have dropped. The turn carries on regardless, and a reload picks it back up.

## [0.5.0] — 2026-09-23

The builder checks its own work now. It loads the app it just wrote in a real browser, uses
it, looks at it, and fixes what it finds before it says it is done — so a page that crashes
is no longer reported as finished. It also stops undoing the edits you make by hand, and the
light theme renders for the first time.

### Added

- **A light theme, a dark theme, and a switcher for them** — three segments in the header
  of every screen: light, dark, and system, which follows the OS and is the default. The
  choice is remembered, applies before the first paint so nothing flashes the wrong
  palette, follows the OS live while it is set to `system`, and reaches your other open
  tabs. In the workspace the group appears from `md` up; below that the bar is full, and
  the projects screen carries it at every width.
- **The builder checks its own work.** A new `check_app` tool typechecks the project and
  loads the live preview in a headless browser, then tells the model what broke — a type
  error, a compile error, a runtime error, or a page that rendered nothing — and what did
  render. The model is told to check after its last write and fix anything it finds, so a
  crashed app is no longer reported as done. It shows in the chat as `check_app /`.
- **…and uses it the way a person would.** `check_app` also takes a screen size (desktop,
  tablet or mobile, the preview pane's own sizes) and a short list of steps — click, fill,
  press, wait — run before the report, so the agent can fill a form and read the result, or
  load the page at phone width. A page wider than the screen is reported by name
  (`HORIZONTAL SCROLL … <nav> 560px wide`). The chat row says what it did:
  `check_app / · mobile · 3 steps`.
- **…and looks at it.** `check_app` takes a question — "is the Greet button readable?" — and
  answers it from a screenshot, so the builder catches what an outline of the page cannot:
  white-on-white text, a covered or clipped element. The picture goes to a separate call and
  only the answer joins the conversation; its cost is counted in the turn's.

### Fixed

- **The builder no longer undoes your hand edits.** A file you changed in the code pane —
  or in any other editor — between two turns was invisible to it, and it could rewrite that
  file from memory and silently drop your change. Each turn now starts with a note listing
  what changed outside the chat, with the diff; it appears in the chat as `✎ These files
  were changed outside this chat…`, and the builder reads the file before touching it.
- **The builder's messages no longer run together.** A turn that spoke twice — before its
  checks and after them — printed "…characters.Added a subtitle…" as one sentence. Each
  new block now starts a new paragraph.
- **A reload shows the chat as it was.** One turn used to come back as a bubble per step,
  with none of its tool rows; it is one bubble again, rows included.
- **Notes read as notes.** `✎ Changed outside the chat` collapses to one line naming the
  files and opens to the diff in monospace, removed lines red and added lines green,
  scrolling sideways inside the note on a phone. `⟲` restore notes are a quiet line, not a
  message from you.
- **An edit made while the builder is working is no longer swallowed.** A file saved from
  another editor during a turn used to land in that turn's snapshot, and the builder was
  never told. The turn's snapshot now holds only what the builder wrote; the other edit is
  its own `edit: outside the chat (during turn N)` in the history tab, and the next turn is
  told about it.
- **The light theme had never rendered**, on any machine, since the file was written.
  `app.css` declared its two colour tokens in a top-level `@theme` and again in one nested
  inside `@media (prefers-color-scheme: dark)` — but Tailwind 4 hoists every `@theme` into
  `:root`, so the media wrapper was discarded and the dark values simply overwrote the
  light ones. The built CSS carried one palette, not two.
- **Syntax colours in the code pane flipped on their own.** They were plain custom
  properties rather than theme tokens, so they were the only colours in the app that the
  media query actually reached: an OS in light mode painted the light syntax palette onto
  the permanently dark page. They now flip with everything else.
- **Scrollbars and form controls follow the theme**, via `color-scheme` — most visible down
  the side of the code pane.

## [0.4.0] — 2026-09-22

apps-builder now knows what version it is. One command moves package.json, the changelog
and the tag together, and the About screen says which of them is deployed here.

### Added

- A version and a changelog, visible in the app. The header carries the version beside the
  name and opens an **About** screen with this file on it, read from the running server
  rather than baked into the bundle — so what it shows is what is deployed.
- `bun run release <major|minor|patch|X.Y.Z>` — the only way a version happens. It refuses
  a dirty tree, a branch that is not `main`, a fork that is behind origin, an empty
  `[Unreleased]`, a version that does not go forwards, and a tag that already exists;
  then it moves `package.json`, this file and the tag together, in one commit.
- `GET /api/version` — the declared version, the deployed sha, `git describe`, and this
  file parsed into entries.
- `bun run check` now fails when `package.json`, `CHANGELOG.md` and the server disagree
  about the version. They did: the tree said `0.1.0` while staging ran `v0.3.0`.

## [0.3.0] — 2026-09-22

Seven defects the existing checks could not see, four of them invisible because the check
that would have caught them was itself broken. It is a merge commit, so this release
reverts in one move: `git revert -m 1 79e1463`.

### Added

- The code pane edits. `PUT /file` existed and had no caller.
- Drawn form-factor icons, and a workspace bar regrouped so six buttons stop reading as one
  six-item control.

### Fixed

- The caret was black on a dark background, so the editor looked read-only.
- One failed build wedged every later deploy of that tag.

## [0.2.0] — 2026-09-21

### Added

- Landing on a gallery of projects; opening one replaces it, so the workspace gets the
  whole window instead of paying a sidebar for projects you are not working on.
- Every preview is photographed while it runs, so a stopped project's card shows what it
  last looked like rather than an empty rectangle.
- Every turn, hand edit and restore is one commit. The history tab puts the project back
  to any of them — code only, or code and the conversation that produced it.

## [0.1.0] — 2026-09-19

- First tagged release. Staging tracks tags from here; dev is the live instance.
