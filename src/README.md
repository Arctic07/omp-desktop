# src — beUI agent workspace

React app whose single screen is beUI's **Chat App** composition (animated, copy-paste components
built on Motion + Tailwind CSS 4), wired to the real engine. It is this application's **only** front
end — the Vue front end it was once built alongside has been removed — and it runs on the
repository's own Rust backend: `src-tauri/tauri.conf.json` builds this app
(`pnpm --filter src dev` / `build`) and points the `src-tauri` crate at its output, so there is
one Rust backend and one front end rather than a second backend.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | React 19 + TypeScript (Vite template, `react-ts`) |
| Build | Vite + `@vitejs/plugin-react` |
| Styles | Tailwind CSS 4 via `@tailwindcss/vite` (`src/index.css`, no JS config) |
| Type | MiSans VF, vendored into `src/fonts/misans/**` (see *Type and colour*) |
| Theme | shadcn preset `nova` (neutral base, CSS variables) + `next-themes` (`class` on `<html>`) |
| Components | beUI, installed with the shadcn CLI from the `@beui` registry |
| Windowing | `@tanstack/react-virtual`, pinned to `3.14.13` — the release built on `virtual-core@3.17.11` |
| Shell | Tauri 2, via `src-tauri/tauri.conf.json` (identifier `com.omp.desktop`) |
| Backend | the repository's own `src-tauri` Rust crate + `host/` engine host — no second backend |

## Commands

```bash
pnpm install          # from the repo root: src is a pnpm workspace member
pnpm --filter src dev
pnpm --filter src build      # tsc -b && vite build
pnpm --filter src typecheck  # tsc -b
pnpm --filter src test       # tsc -p tsconfig.test.json && node --test "src/**/*.test.ts"
pnpm --filter src lint       # oxlint

# As a desktop app, from the repo root:
pnpm tauri:dev                     # tauri dev --config src-tauri/tauri.dev.conf.json (dev identity)
pnpm tauri:build                   # tauri build
```

`test` is the repo's own runner (`node --test` over `.ts` files, types stripped by Node), not a test
framework: the pure modules — the transcript fold, its merge, the Markdown parser, the notice parser —
are covered that way, and anything that needs the desktop is not.

Behaviour that needs a live desktop behind it — one listener per conversation channel, a conversation
with rows showing those rows rather than the empty-conversation notice, the transcript's window under
a fling — has no automated check here: `pnpm tauri:dev` is how it is exercised by hand, and the
suite covers only the pure modules above.

`pnpm tauri:dev` serves this app on port 1421 under the dev identity `com.omp.desktop.dev`, so its
data root is `%LOCALAPPDATA%\com.omp.desktop.dev` — a separate store, engine home, host data and
WebView2 profile from the installed app. The two can run side by side; neither touches the
other's data. The product identity is `com.omp.desktop` (data root `%LOCALAPPDATA%\com.omp.desktop`),
and that is also the keyring service name, so a dev run and the installed app read the same provider
keys: one entered in either is visible to the other.

Vite runs with `strictPort`, so a vite left over from an earlier run makes the whole command fail
with `Port 1421 is already in use` before the Rust side even builds. Kill that vite, not the app:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*\src\node_modules*vite*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

## Adding beUI components

beUI ships a shadcn-compatible registry; there is no npm package and no Tailwind runtime.
The CLI writes each component's source into this project, where it is owned and editable:

```bash
cd src
npx shadcn@latest add @beui/<slug>          # e.g. @beui/card, @beui/table
npx shadcn@latest add @beui/<slug> -o -y    # overwrite existing files
```

Slugs and docs: <https://beui.dev/llms.txt>, registry JSON: <https://beui.dev/r/registry.json>.
Components land in `src/components/motion/**` (primitives) and `src/components/agents/**`
(agent surfaces); shared helpers land in `src/lib/**`.

Only the closure the Chat App actually needs is vendored — components from the earlier
playground (card, table, drawer, toast stack, …) were removed to keep the tree free of unused
source; re-add any of them with the command above. `@beui/tooltip` is one of those and is back: the
title bar's icon-only controls label themselves with it. It is also the one vendored component that
brings a dependency — `@floating-ui/dom`, for the collision-aware placement of its surface.

## Screen

The app opens on **Chat App** (`@beui/chat-app`), full viewport, under a **custom title bar**: the
window is undecorated (`decorations: false`), so `src/home/TitleBar.tsx` draws the frame, the
application name, the rail's collapse control, the `文件 / 编辑 / 视图 / 帮助` menu row and the
minimize / maximize / close buttons. Every control is beUI's `Button` in its ghost variant — the
hover fill is the component's, not hand-rolled — and the icon-only ones (collapse, minimize,
maximize, close) are wrapped in beUI's `Tooltip`, so each says what it does before it is pressed; the
collapse control advertises `Ctrl B`, and `Ctrl B` works. The buttons here drop the component's 2%
hover growth, as every button in a rail row does — `lib/hover-motion.ts` says why: a fractional scale
re-rasterises the icon and the label, and on a 125% display that reads as a blur with the glyph a
half pixel lower. The menu row **opens nothing**: the four menus behind it are not built, so they are
buttons that look live rather than menus that open onto nothing.
The three window buttons are real (`getCurrentWindow()`), which is what the four
`core:window:allow-*` permissions in `src-tauri/capabilities/default.json` are for.

The **sidebar** is the workspace rail: the workspaces the desktop knows, each unfolding into **that
workspace's conversations**, newest first. A conversation gets its row when its first prompt is sent
— that is what starts it, and what the desktop's own index can see — not when it is opened, and not
when the answer arrives. A workspace shows **five** of them; *Show more* adds five
again and *Show less* comes straight back to five, both drawn under the group's last row — the rail
carries the count, the tree puts the control where the group ends. A row carries the conversation's
title (or *untitled*), its mark, and how long ago it moved — `29m` / `10h` / `10d` / `10mo` / `10y`,
localized for `now` alone. The mark is one icon and is **mutually exclusive with the time**: running
turns spin the arc, an unread result wears a full ring, pending / cancelled / error rows wear a still
arc, and a row whose status this build cannot read shows the time instead. Opening a row switches the
conversation; the row
menu renames it, copies the transcript as Markdown, copies the final summary, copies the session id,
or removes it. A **workspace row** carries a *new conversation* button of its own, beside its menu —
the one verb worth offering without opening a panel — and its menu renames it, reveals it in the file
manager, or removes it. The header above the groups adds a workspace through the desktop's own folder
picker (`@tauri-apps/plugin-dialog`, the same dialog the removed Vue front end opened): a path is not
something to type by hand. A workspace opens itself when it becomes active, and again when its first
conversation arrives — the list is read after the folder is added, so a group that was empty at that
moment must not stay collapsed when the first row lands under it. The tree is `movable={false}`:
there is no reorder to offer here.

The **conversation** is the open session's transcript, folded from two sources: the rows already on
disk (`session_history`) and the live stream (`omp:session:<id>`). **One conversation has exactly one
listener, ever** (`session-store.ts`'s `ensureListening`), because every frame is folded by the
listener that carries it: two listeners on one channel fold every frame twice, which is what made a
reply read back with each word repeated. **A turn reads as one speaker**: the engine writes an
assistant message per step — one before a tool call, one after — and only the turn's first answer
draws the avatar and the `智能体` line (`conversation-rows.ts`'s `namesSender`); the answers after a
call are the same agent still talking, and naming each of them put two avatars over one turn's
output. While the history is being read the column draws the master's `LoadingGrid` (a 3×3 pixel
grid whose light sweeps out of the middle, beside the wait's shimmer label) and the header's title
band is hidden — a conversation being opened must not put a stale workspace/title line over the
wait. Assistant rows carry the engine's reasoning in a beUI
thinking row (sparkle + shimmer label + disclosure) above the reply, which is drawn as **Markdown**
(`home/markdown.ts` is a port of the removed Vue front end's parser; `components/agents/markdown.tsx` renders
it) — a streaming answer is revealed by the frame (`components/agents/use-smooth-text.ts`): the painted
Markdown walks a character at a time behind the complete text, so a coalesced delta reads as writing
rather than a jump, while the transcript, the copy action and the rail still read the complete text —
and a block the engine wrapped in its own tags (`<system-notice>`, a `<task-result>` delivery) is
drawn as the card it stands for instead, by `home/system-notice.ts` +
`components/agents/system-notice.tsx`. The shimmer is for reasoning still arriving, so a turn that is
over is a record of what was thought rather than a claim that something still is. **Reasoning is
grouped by the run it belongs to, not by the turn**: a step that thought and then called a tool is a
thought of its own, and each stretch is drawn on the row it was thought on (the removed Vue app's
`SourceConversationEntry` drew one block per assistant entry for the same reason — one output may think
many times). What *is*
merged is a thought the engine merely carried on writing across adjacent messages with nothing in
between; a call, or an answer of the row's own, ends the stretch. Tool calls are
inline chips that collapse a consecutive run into one `N calls` row, and a `task` call shows its
subagent roster in its own expanded body.

**A turn's footer belongs to the turn** — its copy, its 👍/👎 — and it is drawn on the turn's
*last* answer that wrote words (`conversation-rows.ts`'s `endsTurn`), never on each of them: the
engine writes one assistant message per step, and a footer under every step is a conversation that
looks finished five times. It is drawn only once the turn is over — while a turn is in flight nothing
on screen is a finished answer, so `ConversationPane` shows no footer at all — which is the same rule
the removed Vue front end followed, and the reason the buttons used to appear in the middle of a
running turn with rows still arriving under them.

**Every disclosure follows the run until the reader touches it.** The reasoning opens itself while the
reasoning is still arriving and folds when the answer starts; a run of calls opens itself while any
call in it is working; a call opens itself once it has reported output while it is still running (a
call that has said nothing yet stays folded, because a fast one would flash open and shut); a `task`
call opens while its children are unsettled. All of them fold again when the work ends. A reader's own
click outranks that in **both** directions — what they opened stays open after the work ends, and what
they closed stays closed while output is arriving — and it is kept in `ConversationPane` rather than
in the rows, because a windowed transcript unmounts the rows that scroll out of it and a choice kept
in a row would be forgotten the moment it left the screen. The turn in flight has a row of its
own at the foot of the transcript — beUI's `AgentProgress`, whose glyph is the helix `Loader`
(`components/motion/loader.tsx`, drawn on its side): the glyph, `工作中…` and a live
timer, in the content column but with no avatar, because it is the turn's state rather than another
speaker — so the transcript says it is working from the moment the prompt is sent, before the engine
has said anything, and keeps saying so until the turn ends. That timer counts **the turn, not the
visit**: it starts at the host's own stamp for the turn (`SessionRecord.turnStartedAt`, written by
the `turn_started` frame and read by `home/turn-elapsed.ts`), so leaving the conversation and coming
back shows the same reading rather than a stopwatch started at the moment the row was drawn again. A
turn this process attached to mid-turn never saw that frame, and its clock falls back to the prompt
the turn is answering — the same moment the settled footer measures from. A conversation longer than
60 rows is
**windowed** (`home/ConversationFeed.tsx`): the rows around the reader are drawn and the rest are a
height in `home/conversation-rows.ts`'s model, measured one at a time as they come into view, with the
reader's row and its place on screen recorded so a return to the conversation lands on it. A
conversation the reader has **never opened** has no place recorded, and the place it opens at is its
**foot**: the live edge is where a conversation is read from, and opening an old one on the first line
of a transcript the reader has never seen is what "the newest rows are the point" means.

**The follow is the reader's scrolling right, not a geometry snapshot.** Only the reader's own input
(a wheel, touch, a scrolling key, or a press on the scrollport itself) can take the follow away or
give it back; a virtual row being measured, a disclosure folding, a width change re-wrapping the
transcript, and the scroller's own writes all move the view without touching it. A wheel that heads
upwards takes the follow *before* its scroll event lands, so a stream delta committing in between
sees the reader's decision rather than the state update due next render. The reader's place is
written only when they scroll: recording it on every layout commit would replace their anchor with
the offset a measurement happened to leave behind.

**The navigation rail records conversation turns, and is capped to the box it is drawn over.** A
mark is one turn: its card is the reader's prompt as the title and the last body the agent wrote in
answer as the content, clipped with an ellipsis rather than showing a call's arguments or a row's
own label. One mark per row was a stack taller than the transcript — centred in it and clipped at
both ends, which is where the newest mark went with them. `home/rail-rows.ts`'s `selectRailItems`
takes the room the marks may have (the share of the scrollport in `ConversationFeed`'s
`RAIL_VIEWPORT_SHARE`, measured from the scrollport itself and re-read whenever it changes) and
spends it on the turns in the conversation's own order: the newest turn always, then the turns that
begin with a prompt, and whatever room is left spread evenly — so a conversation too long for its
rail is still described end to end rather than only at its foot. Scrolling maps the row under the
middle of the scrollport back to its turn, so the highlighted mark follows the reader from turn to
turn. A conversation with room for every turn is handed over whole, and the accessible name of a
mark still carries the position it is drawn at, over the number of marks actually drawn. The engine's
own plan (`todoPhases`) and the work a turn detached (`runtime.backgroundJobs`) sit above the composer
as **one row of pills** — a phase is one pill (the phase is what the plan is ordered by, so it keeps
its own name and its own `3/5`), a detached job is another, and a block the engine has not reported
draws nothing at all. The pill row is the foot of that group — the last thing before the
composer — and pressing a pill opens its panel **above** the row, full width: the phase's `TodoList`,
or the job's own label, elapsed time and stop control. (A panel under the row would push the pills,
which are what the reader reaches for, away from the field they belong to.) One panel at a time, and only the
reader's press opens one (`home/conversation-blocks.ts` holds the rule, so a block that empties out or
a job that ends cannot leave a panel behind). The engine's dialogs (`ui_request`) occupy the composer's
slot and width, paging when there is more than one.

**Coming back to a conversation is not reopening it.** The store keeps the rows of the last sixteen
conversations it was shown (visit order; the active and any working ones are protected), and the pane
is mounted per conversation with its reader's place read back out of the store — so switching back
draws the transcript it had, at the offset it was left at, with no history walk in front of it. The
listener is released when the screen moves on and the host is told it may take the session back (a
conversation that holds nothing is discarded with its file, so an untouched *new conversation* leaves
no row behind); the walk that follows a return merges into the rows on hand rather than seeding them
again. Opening a row the workspace's own list does not carry is **not** an open: the list is read
again first, and a conversation still missing after that is reported as such — asking the engine for
a conversation with no file hands back a brand-new empty one, which is how clicking a full
conversation once came back as "还没有对话内容".

The **composer** sends through `session_prompt`, stops through `session_abort`, and reads its model
list from the engine's catalogue and its thinking levels from the session's own runtime state — the
ladder is the model's, not a fixed one, and a model that offers `auto` alone has no effort to choose,
so the control is disabled and says `auto`. A conversation that has not reported a model yet is named
by the engine's **`default` role** rather than by the catalogue's first entry, which is what keeps a
new conversation off a provider this app does not offer; `state/model-store.ts` carries the one list
of providers it hides (`cline-pass`) and applies it wherever a model can be *named* — the catalogue,
the provider rows, the role candidates and the roles table's own resolved models — so hiding one
hides it in every place it could be picked or read.

Both controls are writable **before a conversation exists**, which is what makes the first entry
usable rather than merely drawn. They edit the engine's `default` role in that state: a model pick
is `engine_set_model_role('default', …)`, and a thinking-level pick is the same write with the
`:level` suffix (`auto` clears it). That role is the model settings' default, and the engine starts
every new conversation on it — a level chosen inside a conversation writes only that session
(`session_set_thinking`) and is never carried into the next one. A write the engine refuses is
reported as one more row of the composer's notice list.

The composer's frame carries **no divider against the transcript**: the field's own surface
(`bg-field`) is the boundary, which is how the removed Vue front end's composer seat read too. What the
composer's edge *does* carry is a **fade**: a 2.5rem gradient from the pane's colour to transparent,
drawn over the foot of the transcript (`ConversationFeed`), so a row that reaches the composer fades
into it instead of being cut mid-glyph. It is drawn over the scrollport rather than inside it —
nothing about it scrolls — and a pointer goes straight through it.

A reader who has scrolled away from the newest row gets **one way home**: a 28 px corner button
(beUI's `Button`, carrying a 12 px arrow) over that fade, with its name in the `aria-label` rather
than on screen. It is shown exactly while the transcript is not following the live edge, and pressing
it turns the follow back on and takes the floor in one write. The write is instant rather than smooth
— the distance may be a whole conversation — and a windowed transcript aims it at its last row
rather than at a total the model has only estimated.

**No model, no send.** The two controls are locked together, because a thinking strength belongs to a
model: with no model this app can name — a conversation running on a provider it hides, or none at all
— the level control is disabled (its ladder is the model's, and there is no model to read one from)
and the send control is disabled too. The rule is enforced where the prompt is actually sent
(`ConversationComposer`'s `submit`), not only by the button: Enter, a form submit and the queue all
pass the same guard, and a prompt the reader typed stays in the box rather than being swallowed.

**The files a prompt carries are part of the sentence.** A file the reader picks, pastes or drags in
is not a row above the field: it is a **character of the draft**, and the field draws it where that
character is. That is what makes dropping a file into the middle of a written line put it in the
middle, and what makes backspace over a chip take the file out of the prompt. It is also why the field
is a `contenteditable` box rather than a `<textarea>` — no text input can hold an element — and the
whole of that idea is one module of arithmetic (`state/composer-draft.ts`): each attachment owns one
private-use code point (U+E000–U+F8FF) as its address inside the draft, `splitComposerDraft` reads a
draft back as text-and-files in order, and `draftProse`/`draftAttachments` are what the field's own
readings are written out of. The records themselves are held per conversation by
`state/composer-attachments.ts`, which is the only side that talks to the desktop about them.

The ➕ (beUI's `Button`, labelled with beUI's `Tooltip`) opens the desktop's own file picker through
`@tauri-apps/plugin-dialog`, in the folder of the workspace the conversation belongs to
(`api/dialog.ts`'s `chooseFiles`, whose `defaultPath` is the active workspace's `rootPath`). What it
picks — and what is dropped or pasted — is resolved by `import_composer_files`
(`state/composer-attachments.ts`), which re-checks every path and hands back a record pointing at the
reader's own file: nothing is copied, so a tool the agent runs against an attachment edits the file
the reader picked. The chips land where the reader is: the field's handle captures the caret (a drop
names its own point) *before* the import, which is a round trip through the desktop.

**A paste is files or it is words, never markup.** A picture or a file copied from Explorer arrives as
bytes with no path, so the desktop is asked whether the clipboard still names the real file
(`resolve_clipboard_file_paths` — where it does, the attachment is the reader's own file) and stages
what it does not name under its own scratch scope (`save_composer_paste`). A selection copied out of a
browser arrives as its text *and* a snapshot of it, and the words are what was copied. Anything else
with no files on it is inserted as **plain text**: another application's markup, and its own inline
pictures (which are not attachments), have no business inside a prompt.

**A sent message is read back as the draft it was written as** (`home/AttachmentChip.tsx`): the prompt
the host sends is the draft itself, characters included, with one expanded `@<path>` line appended per
file for the engine to read (`src-tauri/src/services/runtime/session.rs::build_prompt`), and reading a
conversation back turns those lines into the attachments the row draws and takes them out of the words
(`src-tauri/src/services/attachment_mentions.rs` — one module owns the line's spelling, so the writer,
a session title and the read cannot disagree about it). So the files come back **inside the bubble, at
the place they stood in the sentence**, and the pairing is positional: the nth character stands for the
nth file (`state/composer-draft.ts::messageSegments`). A file with no character left to stand at — a
message sent before the composer kept them — is drawn at the end of the words rather than dropped, and
a character with no file behind it is dropped rather than drawn as the box its font would show.

**A chip is one box in both places** (`styles/file-chip.css`): the field's chips and a message's are
the same `inline-block` shape at the same size, and only the surface decides the skin
(`omp-file-chip-field` on the composer, `omp-file-chip-bubble` on the reader's bubble, which needs the
hairline to read as a box on it). The one difference is deliberate: a draft's chip carries the ✕, and a
message's cannot, because a control that could take a file back out of a sent prompt would be a control
that does nothing.

**What a chip holds is one hover away** (`components/agents/attachment-preview-card.tsx`): for an image,
**the picture itself**; for anything else, where the file lives. The picture is the desktop's own
`read_external_file` answer (`state/attachment-preview-store.ts`, cached per path by the rules in
`state/attachment-preview.ts`, bounded at `MAX_ATTACHMENT_PREVIEWS`), read when the card *mounts* —
never for a chip nothing visited, so a dozen image chips in a conversation cost nothing until one is
pointed at, and a path that failed is remembered as having failed rather than asked for again. The
message chip hangs it off a beUI `Tooltip` (whose surface is hoverable, which is what a preview needs);
the composer's chips are elements the field builds by hand, so the field reports the chip the pointer is
on and anchors the same card over it, waiting the same 120ms in both directions that the window's other
labels do. A file that is no longer there answers with no picture, and the path stands in its place —
nothing is invented for it.

**A drag from Explorer or VSCode is the field's, not the screen's.** The window config sets
`dragDropEnabled: true`, so Tauri replaces WebView2's own drag-drop handler and the page never sees a
DOM `drop`; the only channel that carries absolute paths is `onDragDropEvent`
(`state/desktop-drop.ts`, subscribed once by `App.tsx`). The composer registers its own field as the
one target (`setDesktopDropTarget`), so a release over the transcript, the rail or anywhere else
attaches nothing — the whole-window drop hint the removed Vue front end had dropped is not back. While a drag is
over the field the field draws a **drop face** over its own box: beUI has no dropzone component, so it
is drawn from this app's own tokens (`bg-field` over `border-border` at the field's radius, the same
precedent `agents/context-gauge.tsx` set) with one line of copy. A folder among the dropped paths is
refused by the desktop and reported on the composer's notice line, in this app's words
(`state/composer-attachments.ts` only carries the code).

**A queued message keeps its files.** `QueuedPrompt` carries the attachments its prompt was written
with (`state/prompt-queue.ts`), the row shows them as the same chips, and the turn's end hands them to
`session_prompt` with the words — the composer's own list is cleared when the message is queued,
because it is no longer the draft on screen. Sending clears it too, once the prompt is on its way; a
conversation that is let go of, or shed by the retention ceiling, drops its held files with its queue
(`session-store.ts`).

**With nothing to draw, the column draws the hero** (`home/ConversationHero.tsx`): the workspace row,
and the composer docked under it. It is one screen for the two states that mean "nothing yet" — no
workspace at all, and a conversation whose first message has not been written — because both ask the
same question, and the only thing that differs is the row, which names the workspace it is in or asks
for one. The row is a beUI `Button` that opens the desktop's own folder picker, the same flow the
rail's own control uses. The mark, the headline and the preview pill the hero used to draw above it
are gone (owner's call, 2026-10-17); the hero is that one row. `ChatAppHome`'s `conversationPhase` is
what decides between the hero, a read in flight, a conversation, and a failure — four facts that used
to be three states of the same empty transcript, which is how "还没有对话内容" once landed over a
conversation that had plenty in it. A failure is beUI's `Alert`, the same surface the composer reports
its own failures with.

What the hero takes from the removed Vue app's own hero (`SourceConversationComposer.vue`'s
`.omp-hero-shell`) is only the *idea* of a workspace row over the box; the layout is not copied. The
stack starts at the **same left edge as the composer**, and the composer is **docked at the foot of
the column in both states** — under a conversation, and under the hero's row — so the box the reader
types in never moves when the first message is sent.

The hero is drawn **inside the composer's seat** (`ConversationComposer`'s `hero` prop): the box the
reader types in keeps its place in the tree, and the hero is the part added above it. So moving
between the hero and a conversation never remounts the composer and never throws a draft away.
**No header is drawn while the hero is up**: `ConversationHeader` returns `null` for the hero phase,
because the only control that band ever carried there was the door to the panel column and this build
has no plugin panel surfaces yet — a window with no workspace at all is the same case, with nothing
on that screen for a header to act on. A workspace always opens on a conversation
(`session-store.ts`'s `runWorkspaceSwitch`): the newest one it has, or the blank conversation the
hero is drawn over when it has none — which is what makes the box in the hero a real prompt rather
than a dead one.

**Opening a conversation is an entrance, not a cut.** The rows of a short conversation pop in one by
one on their own (`ConversationPane`'s `animateIn`), and a windowed one draws no row animation at all
— so the surface carries it: the transcript fades up as one panel when it arrives (`ConversationEntrance`,
keyed by the session), which is what makes a conversation restored at startup *arrive* rather than
simply be there when the window opens. The hero animates the same way, and both fall back to a plain
fade under `prefers-reduced-motion`.

The sidebar's foot carries the **Settings** entry. That page mirrors the removed Vue desktop app's settings
screen — the same 276px section column (Usage, General, Models, Skills, Rules, MCP, Plugins, Memory,
Appearance, Logs, About, in that order), the same groups and rows, and the same copy in both
languages — drawn with the app's own components (`Card`, `Alert`, `Switch`, `Input`, `Select`,
`RadioGroup`, `Checkbox`, `Button`, `AnimatedBadge`, `Tabs`) through the shared vocabulary in
`src/settings/parts.tsx`. **Every section is wired to the desktop**; nothing on the page is a static
render any more. A section is mounted on its first visit and kept mounted (hidden) afterwards, so a
half-written rules file, a search term and a list's scroll position survive a trip to another
section.

It is an **overlay on the window's own frame**, not a screen of its own: the title bar — the drag
region and the three window controls — stays exactly where it was, and the conversation stays mounted
underneath (`inert` while the page is up), so a turn streaming into it is not interrupted by reading a
setting and the reading position is still there on the way back. The page covers the whole body of the
frame, the sidebar included, which is why the frame's sidebar toggle (and its `Ctrl B`) is not drawn
while it is open.

**Models** has the three views the removed Vue desktop app had, behind a beUI segmented `Tabs` bar:
*Model roles* (the engine's role table, split by `section`, with a lazily-fetched candidate list per
row),
*Built-in providers* (the engine's providers, where their API keys are entered, and the catalogue
each one brings through a searchable, paged list) and *Custom providers* (the providers this app
defines itself, with an editor that stores the key before saving so `models.yml` renders `auth:`
from the keyring). Every write goes through `engine_set_model_role`, `provider_set_key` /
`provider_clear_key`, or `custom_provider_*`, and the answer the desktop returns is what gets
rendered — nothing is applied optimistically.

The other ten read the engine and the host through the same rule: **a write's answer is what is
rendered, never a local guess**. `Usage` draws the summary strip, the 53-week activity grid, the
trend chart and the model breakdown from `engine_usage` (two windows: all history, and the range the
reader picked); `Skills` groups the engine's discovered skills by the level it reported and turns
`skills.enabled` / `skills.enable*` / `disabledExtensions` through `engine_skills_set`; `Rules`
edits the engine's user-level `RULES.md` through `engine_rules` / `engine_rules_set`; `MCP` lists
the engine's servers, their definition-file state, their live status and its own configuration
errors, and writes definitions through `engine_mcp_upsert` / `engine_mcp_remove`; `Memory` switches
`memory.backend` and lists each workspace's memory documents from `engine_memory_catalog`;
`Logs` reads `logs_overview` (both the application's log directory and the engine's own, each row tagged with its writer), states the seven-day retention rule, and is the one place that clears the logs or the webview caches;
`About` reads `runtime_status` + `engine_data_paths` and the app's own version, and words the host's
integrity, protocol and credential states; `Plugins` lists what is installed, gates the first enable
of a plugin that runs code behind a consent card (`engine_plugin_grant_set` then
`engine_plugin_set_enabled`), edits a plugin's own declared settings, and browses the registered
marketplaces. `Appearance` lists the themes installed plugins contribute (`omp.desktop.themes`) and
paints the chosen one on the document. `General` is the one section whose first four rows are this
document's own preferences (`state/app-settings`) — the theme, the reading size, the conversation's
density and what a prompt does while a turn runs — with the language, the
engine's context compaction and the tray behaviour read from and written to the host.


## Type and colour

Two rules hold across the whole app — chat, rail and settings alike — and both live in
`src/index.css` as tokens rather than in components.

**Type is MiSans**, from Xiaomi, free for commercial use. `src/fonts/misans/` holds the variable cut
of the simplified-Chinese family as the `misans` npm package ships it (Apache-2.0, 56 `unicode-range`
subsets, ~4.5 MB): only the weights the UI asks for and only the ranges it draws, with the files
copied in so the app renders offline. `--font-sans` puts `'MiSans VF'` in front of the system stack
that used to lead — Latin in Segoe UI and Chinese in Microsoft YaHei meant the two scripts disagreed
about weight and edge, which is what made the text read sharp and slightly blurry at once. The
system stack stays behind it for characters outside the subsets and for the moment before they load.
See `src/fonts/misans/README.md`.

**No text is painted at full white.** The palette shipped with `oklch(0.985 0 0)` — #fafafa, white to
the eye — for every foreground, and against these near-black surfaces it glared instead of ranking.
`.dark` now sets `--ink: #d3d3d3` and points every foreground token at it (`--foreground`,
`--card-foreground`, `--popover-foreground`, `--secondary-foreground`, `--accent-foreground`,
`--sidebar-foreground`, `--sidebar-accent-foreground`); `--muted-foreground` keeps its own step down.
The three chrome surfaces are fixed values rather than theme pairs, because the frame around the
content is the application's own and not part of the light/dark palette:

| Token | Value | Where |
| --- | --- | --- |
| `--color-window-frame` | `#0d0d0d` | title bar |
| `--color-pane` | `#121212` | the conversation column and the composer's own frame |
| `--color-field` | `#1f1f1f` | the composer's input field |
| `--color-titlebar-ink` | `#d3d3d3` | title bar text, same value as `.dark`'s `--ink` |
| `--color-titlebar-muted` | `#8f8f8f` | the frame at rest: the menu row and the window controls, which brighten to the ink on hover |
| `--color-bubble-user` | `#292929` | the reader's own message bubble |
| `--color-bubble-user-ink` | `#d3d3d3` | the text inside it |

Code blocks keep their syntax colours but not their white: `components/agents/agent-code.tsx` reads
each theme's own default foreground (the colour it gives a token it has no rule for) and hands those
tokens back to `var(--foreground)`, so plain code text matches the conversation around it.

## Languages

The app is written in two languages, English and Simplified Chinese, with the same wording the
removed Vue desktop app used:

- `src/lib/i18n.tsx` owns the choice: `LanguageProvider` (mounted in `main.tsx`), `useLanguage()` and
  `useCopy(copy)`. The choice is stored in `localStorage` under `omp-desktop.language` and written to
  `<html lang>` (`en` / `zh-CN`). Until the reader chooses one, the language is the **system's own**
  (`navigator.language`; any Chinese tag resolves to `zh`), so a Chinese desktop opens in Chinese.
- A surface keeps its own wording beside it as a `Localized<T>` record — `const COPY: Localized<XCopy>
  = { en: {...}, zh: {...} }` — and reads it with `const copy = useCopy(COPY)`. Nothing else in the
  app branches on the language, and no string is written twice outside those records.
- The Chinese is this app's own, and its **source of truth** is the copy records beside the surfaces
  that read them: `home/homeCopy.ts`, `components/agents/ai-sidebar-copy.ts`, and the per-section
  `*Copy.ts` files under `src/settings/**` (the rest are `Localized` records inline in the component).
  New wording goes there — nothing is taken from the removed Vue frontend any more.
- The **General** section's Language row is the switch; it applies immediately, across the settings
  surface. The chat screen is localized the same way: `home/homeCopy.ts` carries the screen's own
  wording (the rail, the conversation states, the composer), and the vendored beUI components it
  renders carry their own `COPY` records — `ai-sidebar-copy.ts` beside the rail, the rest inline in
  the component that renders them — so the whole screen reads in the chosen language.

## Layout

```text
src/
├─ App.tsx                  the window's frame + the view switch: chat | settings; starts the
│                           process-wide wiring
├─ api/                     the only IPC surface (wire types, `invoke` wrapper, command wrappers,
│                           and the desktop's own folder picker)
├─ state/                   the stores: workspaces, the models, the conversations this process holds
│                           and the transcript fold — split by domain, since a store's file may not
│                           grow past the 1000-line rule: `session-record.ts` (one conversation's
│                           record: the store, the writers onto it, the readings from it and the
│                           frame fold), `session-store.ts` (the life of those records: open, listen,
│                           walk, let go), `session-lists.ts` (the list they are read from and
│                           the marks on it), `reader-place.ts` (where the reader left each one)
├─ home/ChatAppHome.tsx     the shell (rail + header + conversation + composer slot), and which of
│                           the column's four states it is in
├─ home/ConversationHero.tsx    the hero: the workspace row, over an empty column (composer docked below)
├─ home/WorkspaceRail.tsx   the left rail: workspaces, their conversations, their actions
├─ home/TitleBar.tsx        the custom window frame: name, menus, window buttons
├─ home/ConversationMenu.tsx    the conversation header's ⋯ menu
├─ home/ConversationPane.tsx    the transcript's rows: thinking, Markdown, tool groups
├─ home/ConversationFeed.tsx    the transcript's window: the scroller, the row model, the rail
├─ home/conversation-rows.ts    the rows a conversation folds into, and the rail's list
├─ home/ConversationToolRow.tsx one tool call, its diff/sources/subagent roster
├─ home/ConversationDialogs.tsx the engine's dialogs, in the composer's slot
├─ home/ConversationComposer.tsx the notices, the block row, the dialogs and the prompt field
├─ home/AttachmentChip.tsx      one file a sent message carries, where its words carry it
├─ home/ConversationBlocks.tsx  the plan's phases and the detached work, one pill each
├─ home/conversation-blocks.ts  which blocks exist, and which one is open (pure)
├─ home/markdown.ts         the Markdown parser (ported from the Vue front end)
├─ home/system-notice.ts    the engine's own wrapper blocks, read back out of a message
├─ home/sidebar-tree.ts     the workspace and session stores, shaped as the rail's resource tree
├─ home/conversation-format.ts  unified diff → lines, durations, argument summaries
├─ home/homeCopy.ts         the composition's own wording, both languages
├─ lib/tokens.ts            the one way a token count is written (`517` / `12.2K` / `1M`)
├─ state/composer-draft.ts   the draft as one string: tokens, splitting, ordering (pure)
├─ state/attachment-preview.ts what a preview cache holds, and what it lets go of (pure)
├─ state/attachment-preview-store.ts the previews, read once per path from the desktop
├─ state/composer-attachments.ts the files a composer holds, and the imports that put them there
├─ components/agents/composer-field.tsx the field itself: text and files in one `contenteditable`
├─ components/agents/composer-editor.ts what the box holds, and where the caret is in it
├─ components/agents/attachment-preview-card.tsx what a chip's hover shows (both surfaces)
├─ styles/composer-field.css the field's own type and its hint
├─ styles/file-chip.css      the chip a file is drawn as, in the field and in a message
├─ settings/SettingsPage.tsx   the settings shell (section column + reading column)
├─ settings/parts.tsx          the settings vocabulary (group, card, row, choice, stats, notice…)
├─ settings/sections/*.tsx     one file per section, each wired to the engine
├─ settings/sections/models/   the model page's three views, their shared row and their copy
├─ settings/sections/plugins/  the plugin list, detail, settings form and marketplace store
├─ api/**                   the IPC surface (client, one module per domain, the wire DTOs)
├─ state/**                 the stores (store.ts, resource.ts and one module per domain)
├─ fonts/misans/**          the vendored MiSans VF subsets and their `@font-face` sheet
├─ components/motion/**     beUI primitives (vendored source)
├─ components/agents/**     beUI agent surfaces (vendored source)
├─ lib/**                   shared helpers (i18n, ease, hooks, cn)
└─ index.css                Tailwind 4 entry + the theme tokens + the `scrollbar-hide` utility
```

`@/*` maps to `src/*` (see `tsconfig.json` and `vite.config.ts`) — that alias is what the
shadcn CLI uses to place registry files.

## Notes

- The settings sections are ported from the removed Vue desktop app's settings pages
  (`src/components/settings/*.vue` in that tree): same structure, same rows, same labels in both
  languages, restyled with the app's components. The wording now lives in this app's own copy records
  — the `*Copy.ts` files under `src/settings/**` and the `Localized` records beside each section, read
  with `useCopy` — which are the source of truth for it. Every section is wired to the desktop — see
  the Screen section above for what each one reads and writes.
- The settings page's state is one module per domain under `src/state/`, all built on
  `resource.ts`. That primitive is the one place three rules are written: a later answer always
  wins (a monotonic sequence per read, so a slow read that started before a write cannot put its
  stale value back on screen), a read already in flight is not doubled (a refresh is the explicit
  `{ force: true }`), and a write's answer is *adopted* rather than patched — adopting also
  invalidates any read still in flight. `createKeyedResource` is the same thing for a payload that
  belongs to a workspace or another subject, so `read(workspaceId)` asks the host exactly when the
  subject changes and does nothing when it does not.
- The frontend's own preferences (theme, reading size, conversation density, what a prompt does
  while a turn runs, reduced motion, where a link opens) live in `state/app-settings.ts` under one
  `localStorage` key, and the three that a stylesheet has to act on are written as one custom
  property and two attributes on `<html>`/`<body>` (`src/index.css` reads them). The theme itself
  stays `next-themes`' — a second owner would be a second answer — so the store's part is telling
  the shell which theme the next start opens with.
- The Rust side is unchanged by this front end except for the two settings a desktop window cannot do
  without: `src-tauri/tauri.conf.json` is now the single config, and it carries them itself — its
  `identifier` is the app's own `com.omp.desktop`, its `devUrl` is 1421, its `frontendDist` is
  `../src/dist`, its two before-commands are `pnpm --filter src dev` / `build`, and its
  one `app.windows[0]` holds `decorations: false` directly. There is no second overlay file.
  `pnpm tauri:dev` layers `src-tauri/tauri.dev.conf.json` over it, which overrides nothing but the
  `identifier` (`com.omp.desktop.dev`) so a dev run keeps its own data root.
  `src-tauri/capabilities/default.json` gains the four `core:window:allow-*` permissions the title bar
  calls.
- `src/home/ChatAppHome.tsx` began as beUI's own usage example
  (`beui:components/previews/agents/chat-app-usage.tsx`, MIT) — the registry ships `ChatApp` (the shell)
  but not the composition. The shell is flush/full-height rather than a 760px rounded card.
- `src/home/ConversationHero.tsx` takes the removed Vue app's hero
  (`SourceConversationComposer.vue`'s `.omp-hero-shell`) as a **reference rather than a copy**: the
  workspace row is the whole of what is left of it (the mark, headline and preview pill were removed
  on the owner's call, 2026-10-17), drawn from vendored beUI parts — `Button` for the row, `motion`
  for the entrance — and laid out flush left with the composer, which is docked at the foot of the
  column in both the hero and a conversation.
- beUI's registry does not ship the `scrollbar-hide` utility its components use; it is defined once
  in `src/index.css` (same behaviour as the preset's `no-scrollbar`), so every scroll container —
  including the composer's field — stays scrollbar-free.
- Tailwind v4 leaves buttons on the default arrow cursor, while beui.dev's own stylesheet gives
  every enabled button the pointer. `src/index.css` carries that base rule (`button:not(:disabled)`,
  `[role="button"]:not(:disabled)`), so the vendored components and the app's own controls agree —
  the same rule shadcn's `--pointer` option adds.
- The document is exactly the window and never scrolls (`html, body, #root { height: 100%;
  overflow: hidden; overscroll-behavior: none }`). Without it a two-finger pan inside a pane that has
  reached its end chains out of it and carries the whole frame — title bar included — up and down,
  which reads as the application being dragged around.
- Components are vendored source, not a dependency: upgrading means re-running
  `npx shadcn@latest add @beui/<slug> -o -y` for the affected slugs. These files carry local
  patches that such a re-install reverts:
  - `motion/text-shimmer.tsx` — the registry ships a self-import (`@/components/motion/text-shimmer`);
    it must point at `@/lib/text-shimmer`.
  - `motion/tooltip.tsx` — `process.env.NODE_ENV` → `import.meta.env.DEV` (no Node globals here).
  - `motion/tooltip-surface.tsx` — the entrance is a fade, not the registry's 94% scale-up: on a 125%
    display that fractional scale re-rasterises the label, so the tooltip reads as a blur before the
    text sharpens.
  - `motion/popover-position.ts` — a trigger's box is measured from its layout size rather than its
    painted one, so a popover opened by a press does not anchor itself to the button's 93% press
    scale and jump when that scale settles.
  - `motion/animated-badge.tsx` — the pill and its two slots no longer take part in layout
    projection (`layout` removed): the content still rolls, but the chip keeps its own box and
    cannot scale or slide out of the row it labels when a status changes (2026-10-20).
  - `motion/animated-sidebar.tsx` — split into `animated-sidebar.tsx` + `animated-sidebar-menu.tsx` +
    `animated-sidebar-motion.ts` to keep every file under the 1000-line limit in `rules.md`; the
    folded (`collapsible="offcanvas"`) panel gets `inert` while it is off screen, and the column
    clips (`overflow-hidden`), without which the invisible panel kept taking clicks and focus.
    `useIsMobile` also ignores a viewport under 400px (`COLLAPSED_VIEWPORT_WIDTH`): this window's
    minimum width is 960, so that size is what WebView2 lays out while the window is minimized, and
    answering "mobile" there swapped the shell for its drawer layout — remounting every panel under
    it, which is how the side terminal came back with replayed output and a taller scrollback.
  - `agents/ai-sidebar.tsx` — split into `ai-sidebar.tsx` + `ai-sidebar-tree.ts` for the same limit.
    Six additions for a tree backed by real data: `onExpandedChange` (the caller has no other way to
    learn which workspace was opened, so its conversations can be listed on demand), `expandedIds`
    (the same set controlled, so the rail can keep the workspace it is in open without remounting the
    tree and closing every other group), `movable`
    (a conversation list has no reorder to offer, and the component's moves are optimistic), an
    exported `ResourceMenuAction` so a caller can supply real row actions, `renderRowAction` (a
    button on the row itself, revealed with its menu — a workspace's *new conversation*; it draws
    **after** the "…" trigger, and the two sit in one `gap-1` cluster), and
    `renderGroupFooter` (what to draw after a group's last row — the rail's paging control, which the
    caller draws because only it knows how many conversations the group has). Its default row menu
    was reduced to actions the component can actually perform (rename + the four moves); the demo
    entries with no handler are gone. Its status marks and the composer's context-usage label are now
    read from the copy records instead of hardcoded Chinese. The row's mark and its timestamp share
    one column and never both show: the caller decides which of the two a row earns. An unread
    result is a full ring (`Circle`); only a running turn keeps the arc (`LoaderCircle`) that spins
    (2026-10-20).
  - `agents/prompt-input.tsx` — the context gauge is no longer drawn here: it is
    `agents/context-gauge.tsx`, one component of its own, and this file only passes it the engine's
    numbers. Its field is the one surface that paints `bg-field` rather than a palette token, and it
    is no longer a `<textarea>`: it is `agents/composer-field.tsx`, a `contenteditable` box, because
    the files a prompt carries are *characters of the draft* and no text input can hold an element
    (`state/composer-draft.ts`, `agents/composer-editor.ts`, and the *files a prompt carries* section
    above). This file keeps what the field is *framed* by — the box, the model control, the gauge, the
    send/stop controls — and hands the caller the field's own three verbs through its `ref`
    (`captureAnchor`, `insertChips`, `focus`), so an import can put chips where the reader is and this
    file can put the caret back after a submission. Its old `fieldContent` slot is gone with the
    textarea it was a row above. It also gained **`allowEmptySubmit`**: the registry's rule is that an
    empty box has nothing to send, which is right for a box holding only words and wrong for one
    holding a file among them, so the caller says whether it has something of its own to send and the
    control and the Enter gesture follow that answer instead of the text alone.
  - `agents/composer-field.tsx` / `agents/composer-editor.ts` / `styles/composer-field.css` /
    `styles/file-chip.css` — **new**, and the field itself: the box's content as a draft (text + one
    element per attachment), the caret/selection/point ↔ draft-index translations a `contenteditable`
    needs, and the chip's own inline typography (`styles/file-chip.css`, which the chip a *sent*
    message carries draws from the same rules). `composer-editor.ts` is a React-side port of the
    removed Vue front end's `vue:src/utils/composerEditor.ts` — same coordinates, same `data-chip-token`,
    same reasons
    — with two differences: the chip's glyphs are `lucide-react`'s own geometry written as markup (a
    chip is built without React, because painting a controlled tree into a `contenteditable` rewrites
    the nodes the caret lives in), and a paste is text rather than markup.
  - `agents/attachment-preview-card.tsx` — **new**, and what a chip's hover shows: the picture an
    image file holds, or where a file that has no picture lives. One card serves both surfaces — the
    message chip hangs it off a `Tooltip`, the composer's chips hand their own element over as the
    anchor (`composer-field.tsx`) — and mounting it is what asks the desktop for the bytes.
  - `home/AttachmentChip.tsx` — **rewritten**: a sent message's file is drawn *inside* the bubble, at
    the place it stood in the sentence, as the same chip the field draws (no ✕, and no size — the
    field's chip has none either), with the shared preview card on hover. `home/ConversationPane.tsx`
    renders the row's segments (`state/composer-draft.ts::messageSegments`) instead of a chip row
    under the bubble, and the three places that draw a user message as plain text strip the files'
    characters (see the attachment note above).
  - `agents/context-gauge.tsx` — **new**, and the one vendored-surface file that is not a port: the
    registry's chat-app draws its context figure as a fixed placeholder, and this app has the engine's
    real accounting. The ring and the card are the registry's own material (`MorphPopover`, the
    composer's surface radius and type), fed by `contextTokens` / `contextWindow` /
    `contextAnchored` / `contextCategories` / `autoCompactPercent` / `sessionUsage` from the runtime
    snapshot: the share, the category legend, the auto-compact line and the cache rate are all the
    engine's numbers, the estimated case wears `≈`, and a window the host never reported leaves the
    share out rather than drawing it over a denominator nobody gave. The ring is an SVG circle with
    `stroke-dasharray` = its circumference and `stroke-dashoffset` = what is left of it, so the arc's
    **length** is the share. It used to be two rounded borders with two sides transparent, rotated by
    `45° + share × 3.6°`: that draws one fixed quarter turn wherever it is put, so 2% and 50% were the
    same picture at different angles.
  - `agents/agent-disclosure.tsx` — the body is mounted while the block is open and unmounted while
    it is closed (`open ? children : null`). The box is collapsed by its own height, not by the
    animation, so the closing frames were clipped to nothing anyway; keeping the body mounted only
    bought the cost of every collapsed tool call tokenizing its arguments and its whole result through
    shiki — a turn with a few dozen calls mounted all of them at once, which is what made a
    tool-heavy conversation crawl.
  - `agents/todo-list.tsx` — nothing changed in the file, but the composer drives it differently now:
    it is the *panel* a block opens onto, so it is drawn `open` (the row's pill is the trigger) and
    with `collapseOnComplete` off — every block starts folded, and the one the reader opened is theirs
    to keep, including after the work it reports is finished.
  - `agents/agent-activity/types.ts` + `index.tsx` + `activity-row.tsx` — an optional
    `onItemSelect` is threaded down to `ActivityRow`, and a **trace** row is drawn as a
    `<button type="button">` when a handler is given and as the `<div>` it has always been when it is
    not (same box, same three-cell grid, plus `text-left` so the button's own centring does not reach
    the label). A trace may also carry `mark` / `markLabel`: the first cell then draws a spinner, a
    check or a cross (and a visually hidden state word) instead of the kind glyph. The vendored
    component keeps that support, but the `task` roster no longer uses it: `home/TaskAgents.tsx`
    draws the batch itself (a heading of count, models and `done / total`, then one clickable line
    per child with its mark, name and ordinal, which opens that child's own conversation in the tool
    column). No other kind of row is selectable and nothing else about the rendering changed.
  - `motion/animated-sidebar.tsx`, `home/TitleBar.tsx` — the frame's sidebar toggle is optional
    (`onToggleSidebar` absent = not drawn), because the settings page covers the sidebar and a control
    for something the reader cannot see is a control that does nothing. The provider's `Ctrl B` binding
    is optional too (`keyboardShortcut`, default true): the placeholder right column sits in a second
    provider on the same screen, and a second listener would move both columns with one key.
  - `motion/loader.tsx` — **new** (registry `@beui/loader`, which ships seventeen variants). Only
    the `helix` one is vendored: it is the running row's glyph, so the sixteen this app does not draw
    are not kept unused. The helix is turned a quarter turn (`-rotate-90` on its box, not on the
    animation), because the registry draws it as a column of rows whose dots cross left-to-right while
    this glyph sits in a one-line row that itself reads left-to-right: on its side the rows run along
    the row's axis and the crossing is vertical. The announcement is opt-in rather than the registry's
    English "Loading" default — this app's wording lives in a `Localized` record read with `useCopy`,
    and the one caller both supplies its own verb and hides the loader from screen readers.
  - `agents/loading-states/agent-progress.tsx` — the running row's screen-reader label is the
    caller's own verb, without the registry's English ", in progress" after it. Its glyph is the
    vendored `motion/loader.tsx` helix rather than the registry's pulsing 3×3 grid, in the row's own
    ink (`text-current`, so the glyph is the row's `text-muted-foreground` and not the loader's
    default `text-foreground`) and `aria-hidden`, because the `role="status"` above it already says
    the row is working and a second one would say it twice.
  - `agents/agent-code.tsx` — plain tokens are handed back to `var(--foreground)` instead of the
    theme's white (see *Type and colour*). It also carries the file panel's grammar loading: the
    bundled set is still the conversation's own, and every other language is fetched on demand once
    per grammar (`ensureLanguage`, deduplicated across callers), with `useAgentCodeTokens` taking an
    optional size bound so a file preview can colour 96 KiB while a tool row still stops at 24 KiB.
  - `agents/message-bubble.tsx` — the `solid` variant is the reader's own bubble, so it is painted
    `bg-bubble-user` / `text-bubble-user-ink` rather than the registry's inverted
    `bg-foreground` / `text-background`, which on these surfaces is a light block. The bubble's body
    type is `--omp-content-font-size` rather than `text-sm`, for the same reason the composer's is.
  - `agents/markdown.tsx` — the answer's body type is `--omp-content-font-size` rather than `text-sm`:
    it is the one other surface the General page's reading size is about, and the three of them
    (bubble, Markdown, composer) have to move together or the conversation stops looking like one
    document.
  - `agents/streaming-response.tsx` — the content surface no longer carries the descendant typography
    it shipped with (`[&_p+p]`, `[&_ul]`, `[&_pre]`, `[&_code]`, …). Its child is this app's Markdown
    renderer, which styles those elements itself, and the `[&_pre]`/`[&_pre_code]` pair was reaching
    *inside* the code block's own card — the one place a fence's padding, border and background are
    that component's to decide. What is left on the surface is its own type.
  - `agents/message-scroller.tsx` — two additions for a transcript that is windowed, both of them
    what the caller already knows and the scroller cannot: `rail` hands the rail its rows from the
    conversation's own row model (with the active row and what to do when one is picked) instead of
    having the scroller enumerate `[data-slot="message"]` out of the document, and `onTakeBottom`
    lets the caller take the transcript to its live edge, which for a window is a row of its model
    rather than the scroller's own floor. With a `rail` given, the scroller walks nothing: the
    mutation observer that re-derived every row's preview text on every frame is not installed, and
    the layout reads that kept the rail in step are not made — which is what turns a streamed delta's
    rail cost from O(rows) into O(changed). The DOM-derived path is kept as it was for any caller
    that has no model to offer. Its viewport also clips the cross axis (`overflow-x-hidden`): the
    conversation reflows with the column beside it, and wide material (a code block, a table) keeps
    its own horizontal box instead of turning the transcript into a surface the reader has to pan.
    It also exports `RAIL_TICK_SIZE_PX`, the height one tick is drawn at: the caller that caps the
    list to the room the rail has needs that number, and it has to be the number the rail is drawn
    at.
  - `motion/preview-rail.tsx` — `ariaLabel` may be a function of the row's position rather than a
    string (`(index, total) => …`), the ticks and the preview cards are each a memoized component
    (`RailTick`, `RailPreview`), and the rail's own per-item handlers are held in a ref so their
    identity cannot reach the ticks. All of it is for a long list whose entries are re-used by
    identity: a name spelled out per row carries the row's position, so every entry would be new the
    moment one row was appended; a handler closed over a caller's callback would be a new prop for
    every tick on every change; and a tick drawn again is a tick the whole list is walked for. The
    rail composes the name where it draws the row, and a tick nothing changed about is not drawn —
    measured at one tick per streamed delta against 1026 before.
- The `components/agents/**` surfaces the chat screen renders carry local i18n patches on top of the
  registry source: each holds a `const COPY: Localized<…>` record read with `useCopy`, and
  `ai-sidebar-copy.ts` keeps the rail's wording beside its component. Re-installing those slugs
  reverts the Chinese wording along with the layout patches above.
- `components/agents/thinking-level-select.tsx` is **kept but unreferenced**: the wired roles panel
  builds its level picker from the beUI `Select` primitives and only offers levels the engine
  reports, which is the behaviour we want (the component offers all eight levels unconditionally,
  which is wrong for a model whose `thinkingLevels` is empty). It stays on request; it is the one
  vendored file here with no user, so it is also the first candidate if the tree is ever pruned.
- Styling must use the tokens from `src/index.css` (`bg-card`, `text-muted-foreground`,
  `border-border`, `bg-field`, …) so light/dark both work; do not hardcode colors.

## Known gaps

- **The transcript is windowed above 60 rows** (`FEED_VIRTUALIZATION_THRESHOLD` in
  `home/ConversationFeed.tsx`, the same threshold the removed Vue front end's
  `SourceConversationFeed.vue` used). Above it only the rows around the reader are drawn; below it
  every row is real DOM, exactly as before. The model is `@tanstack/react-virtual`, pinned to
  `3.14.13` — the release built on `virtual-core@3.17.11` (see *Stack*) — with the same overscan (6
  rows), the same flat estimate (48 px), an end anchor and the same 2 px "at the end" threshold. Two
  things the window cost that the old transcript did not have to think about are handled in
  `ConversationFeed`: the reader's place is recorded as *the row under the reading line* beside the
  pixel offset (a fresh window's offsets are estimates until it measures the rows it draws, so the
  offset alone would land the reader on whatever the estimates put there), and the rail's rows come
  from the conversation's row model rather than from the document. What is left worse than the old
  transcript: a row is redrawn when the window scrolls it back into view, so a fling through a very
  long conversation costs the rows it passes, and a windowed row does
  not play the entrance pop-in — the removed Vue front end's own feed drew its windowed rows still for
  the same reason. The rail keeps one O(marks) moment of its own: the accessible name of every tick
  carries how many marks are drawn, so the row that changes that count redraws every tick once. A
  streamed delta — the same row, more words — redraws one.
- **The per-tool presentation table is not ported.** The removed Vue front end gave each known tool a
  name, an icon and a summary key (`conversationTypes.ts`'s `TOOL_PRESENTATIONS`: `web_search`, `fetch`,
  `search`, `grep`, `glob`, `task`, `todo`, …). A tool row here is titled by the engine's own
  `intent`, falling back to a generic argument summary, and carries no icon.
- **The turn tail is not drawn**: token usage, duration, tokens/second, the model, the turn's clock,
  *copy this turn* and *continue from here* (`SourceTurnTail.vue` in the removed Vue front end). The
  rows carry `usage`, `startedAt` and `endedAt` and nothing reads them yet.
- **No trajectory tab.** The removed Vue front end could switch the conversation to a step ledger
  (`SourceTrajectory.vue` + `sourceTrajectoryData.ts`); here the conversation is the only view.
- Images the engine returns are shown as plain `<img>`, without the labelled gallery and the
  full-size viewer the removed Vue front end drew (`SourceToolImages.vue`); beUI's `ImageGeneration`
  wants the generation prompt and resolution, and `message_finished` carries neither.
- The context meter reads the engine's real accounting — the share, the category legend, the
  auto-compact boundary and the cache rate — the same figures the removed Vue front end's
  `SourceContextMeter.vue` drew from `contextCategories` / `autoCompactPercent` / `sessionUsage`.
  The one thing it does not draw is that meter's segmented bar (one segment per category): the
  card's bar is a single fill over the window, and the legend under it names each category's own
  share.
- The title bar's `文件 / 编辑 / 视图 / 帮助` row is four buttons that open no menus: the menus behind
  them are not built. So are the conversation menu's *pin*, *fork*, *export* and *archive* entries:
  they close the menu and do nothing. Everything else in the rail, the header and the frame is wired.

- A prompt sent while a turn is running has **no dock of its own**: the queue is a plain list above the
  field with a remove control and the head row's *steer*, where the removed Vue front end drew
  `SourceQueueDock.vue` (per-row edit and steer, a counted collapsed line) and `SourcePendingPrompt.vue`.
  The rules themselves are ported: the gesture decides queue vs steer, and a turn's end releases exactly
  one row.
- **The right column is back (2026-10-18; 文件 wired 2026-10-19).** `components/workspace/right-sidebar.tsx`
  carries the three entries (`改动 / 终端 / 文件`). Terminal, changes and files are all
  real surfaces; the former **外部文件** and **侧边聊天** entries were removed on the owner's call
  (2026-10-20). The terminal is a
  real pty (`api/terminal.ts` + `components/workspace/TerminalPanel.tsx` = xterm + `addon-fit` +
  `addon-web-links` over `terminal_open/write/resize/close`; the shell is the desktop's own choice —
  PowerShell 7, then Windows PowerShell, then `cmd`). **「文件」** is a singleton strip tab
  (`state/file-panel-store.ts` + `components/workspace/file-panel.tsx`): a lazy, virtualized tree on
  the left and the one preview on the right, read through `list_workspace_entries` /
  `read_workspace_file` / `search_workspace_paths`. Its header row is the search field and nothing
  else (owner's call, 2026-10-20). A file row can be dragged into the composer, and so can a changed
  row in the changes panel: because Tauri's file-drop channel is on (it is what gives Explorer/VS Code
  drops their absolute paths), each row runs the gesture itself through `state/file-drag-store.ts`
  rather than HTML5 DnD. A `task` child's own conversation is a strip tab opened from its roster row in the
  tool output, or from the detached subagent row above the field; that transcript draws no
  usage/model footer (its run is a step of the parent's turn) and says **运行中** while it works.
  **Right-column state is per
  conversation** (`state/panel-store.ts`): opening it in one conversation does not open it in
  another, and the terminal tabs that are not this conversation's are kept mounted
  (`absolute inset-0` + `invisible`) — closing a tab ends its shell, switching conversations does
  not. The shell's working directory follows the workspace the **owning conversation** belongs to
  (recorded in `cwdRef` at mount), so switching workspaces does not restart a shell that is still
  running. The column's `Ctrl B` binding is off (`keyboardShortcut={false}`) because the rail already
  answers that key — one key must not move two columns. The conversation column is the flex
  remainder beside this panel: the transcript clips its cross axis, wide blocks scroll inside their
  own boxes, and the turn footer wraps, so a wide right column reflows the conversation instead of
  making it a surface the reader has to pan. The host-side and Rust-side plugin **system** — marketplace, install,
  permissions, panel hosting, plugin commands, the built-in seeding **framework** — is untouched and
  stays in place, and the built-in plugin ships again (2026-10-22 restore): the reserved marketplace
  `src-tauri/resources/builtin-browser-marketplace/` carries `omp.terminal` (the panel plus the agent
  skill), declared in `src-tauri/src/services/plugins/builtin.rs`'s `BUILTIN_DEFINITIONS` and seeded
  through the reserved scope. Whether the model sees it is the plugin's own switch; the host only
  deletes the retired native-skill copies the plugin used to leave behind (`host/src/legacy-skills.ts`).
- The composer's model chip shows the engine's raw level words (`auto`, `high`), while the settings page
  shows localized ones.
- The rail's group header has one control (add a workspace); the reference design has two.
