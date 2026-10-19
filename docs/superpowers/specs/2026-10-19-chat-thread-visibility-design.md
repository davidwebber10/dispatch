# Chat thread visibility: design

Date: 2026-10-19
Status: draft, awaiting owner review
Base: origin/main 91b15fdd (v3.1.7)
Parent spec: `2026-10-13-endless-chat-design.md` (called "the Chat spec" below)

## 1. Goal

Chat starts threads for large work, but the owner cannot see that work from Chat. The
projects pane shows three counts and two lines of the last report. A thread that Chat starts
mid-turn does not show until the turn ends. To read a thread, the owner must leave Chat.

This change gives Chat a light view of delegated work and of what else runs in each project:

1. The pane updates when a thread starts, stops, or starts to wait.
2. The pane lists each project's recent threads: name, harness, state, start time, latest step.
3. Each row says who started the thread: Chat, Overseer, the owner, or a scheduled role.
4. A compact "Started" item shows in the chat the moment Chat starts a thread.
5. Threads that wait for the owner come first, highlighted, with the question they ask.
6. Every thread opens in place, in the Overseer's thread lightbox, so the owner stays in Chat.

The owner approved all six items. Item 4 is the owner's favorite. The in-place lightbox is
the owner's addition.

### Non-goals

Chat is not becoming Overseer. The owner still uses Overseer, the Work tab and the board.
This change does NOT add:

- A board, columns, swim lanes, or drag and drop.
- Ledger items, decision cards, or recaps in the pane (Overseer owns them).
- Thread controls in the pane rows (stop, archive, reply). The lightbox has them already.
- Any change to what the model sees. The per-turn status block (Chat spec section 5) and the
  log stay as they are. No new message kind.
- A new thread viewer. Chat reuses the Overseer's `WorkerLightbox`.

### Behavior rule (context only, no code)

Chat always delegates through real `spawn_agent` threads, never through private background
agents (the Claude Code Task or Agent tool). Only real threads show in the pane, in the
"Started" item, and in the lightbox. This spec relies on the rule; it does not enforce it.
The owner keeps the rule in the Chat instructions setting. See open question Q7.

## 2. Current behavior (verified in code)

| Area | Today | Where |
|---|---|---|
| Right pane | A 280 px aside on desktop; a "Projects" sheet on mobile | `packages/web/src/components/endless/ChatMode.tsx:45-50` |
| Pane content | One card per project: live, need you, open counts, and two lines of the last report. No thread names. Nothing is tappable | `packages/web/src/components/endless/ProjectsPanel.tsx:27-48` |
| Pane data | `loadProjects()` calls `GET /api/endless/projects` | `packages/web/src/stores/endless.ts:146`, `packages/core/src/routes/endless.ts:56` |
| Counts | `collectProjects`: live = terminals with status `working`, needsYou = `needs_input`, openItems = open ledger seqs, lastReport = last `work` message. Archived threads are excluded (`listBySession` filters `archived_at IS NULL`). The counts mix Overseer, owner and Chat threads | `packages/core/src/endless/status-block.ts:18-33`, `packages/core/src/endless/service.ts:406` |
| Refresh | Only on ChatMode mount, a `work` message, a turn end (idle, failed, interrupted), and the manual button. No timer | `packages/web/src/stores/endless.ts:167`, `:179-181` |
| Thread events | The daemon already broadcasts `terminal:created`, `terminal:status` (with `status`, `threadStatus`, `activity`), `terminal:exit`, `terminal:removed` to every client. `useEndless.applyEvent` gets them and ignores them | `packages/core/src/routes/terminals.ts:52-62`, `packages/core/src/status/service.ts:419`, `packages/web/src/App.tsx:136-145` |
| Live state overlay | `useThreadStatus` keeps the latest status and activity label per terminal from those events | `packages/web/src/stores/threadStatus.ts` |
| Spawn from Chat | `spawn_agent` in the memory MCP creates the worker with `origin: 'endless'`, arms a report, sends the task, and returns `{ agentId, label, project, folder }` as JSON text | `packages/core/src/endless/memory-mcp.ts:234-253` |
| Tool rows | The turn runner logs each `tool_use` as a `tool` message (`name {json}`) and each `tool_result` as an `echo` message, as they arrive, mid-turn. Each log write broadcasts `endless:message` | `packages/core/src/endless/turn-runner.ts:329`, `:336`, `packages/core/src/endless/service.ts:328-338` |
| Tool row fold | `foldRows` pairs a tool with the echo only when the echo is the very next message. Two parallel tool calls (tool A, tool B, echo A, echo B) pair B with A's result | `packages/web/src/components/endless/EndlessMessageRow.tsx:19-30` |
| Reports | A long report folds; "Open thread" calls `requestOpenThread` and `setView('workspace')`, so the owner leaves Chat | `packages/web/src/components/endless/EndlessMessageRow.tsx:89-143` |
| Who started a thread | Partly stored, in `terminals.config` JSON: `origin: 'endless'` (Chat), `role: 'coordinator'` (the Overseer itself), `role: 'agent'` (a spawned worker), `roleRun` (a scheduled role run). No field says WHICH thread spawned a `role: 'agent'` worker: the Overseer and any peer thread both use the agency MCP `spawn_agent` | `packages/core/src/overseer/worker-payload.ts`, `packages/core/src/endless/reports.ts:21`, `packages/core/src/sessions/service.ts:1164-1174`, `packages/core/src/overseer/agency-mcp.ts:626-668` |
| Overseer thread modal | `WorkerLightbox`: a modal that renders any thread on its own surface (structured threads as `ChatView`, CLI threads as `TerminalTab`), with interrupt, stop and archive, and a near full-screen sheet on mobile with safe-area padding. Opened by `useOverseer.getState().drillInto(id)`. The board already reuses it outside Overseer, inside its own `.overseer-root` div | `packages/web/src/components/overseer/components/WorkerLightbox.tsx`, `packages/web/src/components/board/BoardView.tsx:337-345`, `:441-443`, `packages/web/src/components/overseer/OverseerMobile.tsx:239` |

## 3. Design

### 3.1 Live updates (item 1)

No new server event. The events that the owner asked for already exist. The web store uses
them.

- `useEndless` gets a `watch()` / `unwatch()` pair (a counter). `ChatMode` calls `watch()` on
  mount and `unwatch()` on unmount. With no watcher, thread events do nothing. So the rest of
  the app never pays for the pane.
- While watched, these events schedule one pane reload (trailing debounce 600 ms, at most one
  reload in flight, one more queued if events arrive during it):
  - `terminal:created`, `terminal:exit`, `terminal:removed`;
  - `terminal:status` when the coarse `status` differs from the status the pane has for that
    thread, or the thread is not in the pane yet.
- A `terminal:status` that only changes `activity` does NOT reload. The row reads its latest
  step from `useThreadStatus` directly (section 3.2), so it still updates live.
- Backup: a 60 s timer reloads while watched and `document.visibilityState === 'visible'`.
- A `visibilitychange` to visible reloads at once. iOS stops timers and the socket in a
  background PWA, so this is the main path on the iPhone.
- `resyncAfterReconnect()` also reloads the pane (broadcasts were missed).
- The existing triggers (mount, `work` message, turn end, manual button) stay.

### 3.2 Thread list under each project (item 2)

The pane keeps one block per project. Under the project's name and counts, it lists the
project's visible threads.

**Row, line 1:** a state dot, the thread name (one line, ellipsis), the start time
(`14:02` today, `Mon 14:02` this week, else the date).

**Row, line 2 (mono, 11 px):** who started it (section 3.3), the harness (`Claude`, `Codex`,
`OpenCode`, from the catalog label), and the latest step:

- working: the live `activity` label from `useThreadStatus` (for example "Running: npm test"),
  else "working";
- needs you: the question (section 3.5);
- queued: "queued";
- error: "stopped with an error";
- done or idle: "finished 14:40" (from `lastActivityAt`).

The latest step is live only. It is not saved: after a reload, a working row shows "working"
until the next status event. That is accepted (later: section 9).

**Tap:** opens the thread in the lightbox (section 3.6).

**What is visible (the quiet rule).** The server filters, so 18 projects and hundreds of
threads still give a short list:

- Agent threads only (`isAgentType`). No file tabs.
- Not archived (already true).
- Not the project's own Overseer coordinator thread (Q2). Its open items stay in the counts.
- A thread is visible when it is working, needs you, queued, or errored, OR it finished
  today (its `last_activity_at` is after local midnight, in the daemon's time zone).
- At most 6 rows per project show at first. A "+N more" line opens the rest in place.
- At most 60 rows in the whole response. Past that, the response carries only counts for the
  remaining projects. This guards the response size; it should never trigger in normal use.

**Order inside a project:** needs you, then working, then queued, then error, then done.
Inside a group, the newest activity first.

**Finished threads** (done or idle today) fold under one line per project:
"Done today (3)", closed by default. The open state is local to the panel and survives
reloads (keyed by project id in component state).

**Which projects show:** a project with at least one visible thread, a need-you count, or open
items. A project with only open items shows its header line and no rows. Projects with a
thread that needs you come first; then projects by their newest thread activity.

### 3.3 Who started it (item 3)

The server derives one value per thread, `startedBy`:

| Value | Label | Rule (first match wins) |
|---|---|---|
| `chat` | Chat | `config.origin === 'endless'` |
| `role` | Role | `config.roleRun` is a non-empty string |
| `overseer` | Overseer | `config.role === 'agent'` and `config.spawnedBy` is the project's coordinator, or `spawnedBy` is missing (rows from before this change) |
| `thread` | via thread name | `config.role === 'agent'` and `config.spawnedBy` is another thread |
| `user` | You | anything else |

The only data change: the agency MCP records the spawner. `spawnAgent` and `queueAgent` in
`packages/core/src/overseer/agency-mcp.ts` pass `spawnedBy: callerTerminal()` (the
`DISPATCH_TERMINAL` env value it already reads) to `buildWorkerCreateBody`, which writes it
into `config` next to `spawnDepth`. Chat does not need it: `origin: 'endless'` already marks
Chat threads.

For `thread`, the row says "via" and the parent's label. When the parent is a Chat thread,
the row says "Chat, via" and the parent's label, so sub-threads of Chat work count as Chat
work.

Old rows with no `spawnedBy` fall back to `overseer`. A few old peer-spawned threads can show
the wrong label. They leave the list at midnight (the quiet rule), so no migration is needed.

### 3.4 The "Started" item in the chat (item 4)

**Decision: no new message kind.** The item is a new way to DRAW the `tool` and `echo` rows
that the turn runner already logs mid-turn for `mcp__memory__spawn_agent`.

Why: the tool row is logged and broadcast the moment the model calls the tool, and the echo
the moment the spawn returns (about 1 to 2 s later). A new kind would add rows to the
append-only log and the model's view, change the fixed system prompt (the kind list), and
sit between the tool row and its echo. Drawing the existing rows needs no core change.

**States of the item** (one line, a light card, smaller than a report card):

| Rows present | Shows |
|---|---|
| tool only | "Starting" and the `name` from the tool input, the target project, dim, no tap |
| tool and echo, echo parses as JSON with `agentId` | "Started" and the `label` from the echo, the project, the harness, a live state chip; tap opens the lightbox |
| tool and echo, echo has no `agentId` | "Could not start" and the name, then the first line of the echo text |

**Updates in place: yes.** The chip reads the thread's state from the pane data plus the
`useThreadStatus` overlay: working (green, pulsing), needs you (yellow), done, error. No log
row changes. A thread that is not in the pane any more (finished before today, archived) shows
no chip; the tap still opens it. What the lightbox shows for an archived or deleted thread is
not checked yet; task 5 checks it and, if the lightbox shows an empty chat, the item drops the
tap for a thread that `GET /api/terminals/:terminalId` does not return.

**With reports:** the "Started" item sits where the spawn happened, inside the turn. The
thread's report arrives later as its own `work` card (PR #91 fold rules, unchanged). Both open
the same thread. The "Started" item does not fold and has no body.

**Pairing fix (needed for this item and right for all tool rows):** `foldRows` pairs a run of
N consecutive `tool` messages with the run of up to N consecutive `echo` messages right after
it, in order. A tool with no echo yet stays a tool row alone. Today's one-to-one case is a run
of 1, so it does not change.

Assumption, not yet checked: Claude Code returns parallel tool results in the order of the
calls. Task 4 checks it with a real two-spawn turn before it builds on it. The "Started" item
takes the thread id and label from the echo JSON, not from the tool input, so a wrong pair can
only show the wrong project in the "Starting" state, never open the wrong thread.

**Project filter:** a tool row carries the turn's project tag, not the spawn's target project.
With a project filter on, the item shows under the turn's tag. Accepted (Q5 lists the
alternative).

### 3.5 Waiting threads first (item 5)

- A "Needs you" section sits at the top of the pane, above the projects, when any visible
  thread needs you. It lists those threads across all projects, with a yellow left border
  and the project name on line 2.
- Each such row shows the question in up to 3 lines (no ellipsis inside a word). The server
  fills `question` for `needs_input` threads only, with the same logic as the Chat report's
  interim text (`EndlessService.waitingText`: the pending AskUserQuestion questions and options
  or the gated tool, else the thread's last output). It is cut to 280 characters.
- The same threads also stay in their project blocks (in the needs-you group), so a project
  block is complete on its own.
- The toolbar "Projects" button shows a yellow badge with the need-you count. On mobile the
  pane is a closed sheet, so the badge is the main signal there.
- Answering happens in the lightbox (its `ChatView` already shows the question and the
  options). The pane does not answer.

### 3.6 Open threads in place (the owner's addition)

**Decision: reuse `WorkerLightbox` as is, the same way the board does.** No new modal, no
fork of the component.

- `ChatMode` mounts `<div className="overseer-root"><WorkerLightbox /></div>` once, and
  imports `overseer/tokens.css` (the board's pattern, `BoardView.tsx:35`, `:441-443`). The
  lightbox needs the scoped tokens; outside `.overseer-root` they resolve to nothing.
- A new helper `openThreadInPlace(projectId, terminalId)` in
  `packages/web/src/components/endless/openThread.ts`:
  1. If `useTabs.byProject[projectId]` is not loaded, await `useTabs.getState().loadTabs(projectId)`.
     The lightbox picks `ChatView` or `TerminalTab` from that list; without it a CLI thread
     opens as an empty chat.
  2. Call `useOverseer.getState().drillInto(terminalId)`.
- Three callers: a pane row, a "Started" item, and the report card (the short card tap and the
  folded "Open thread" button). The report card no longer calls `setView('workspace')`.
- On mobile, a pane row tap closes the Projects sheet first, then opens the lightbox. The
  sheet (`Modal`, z-index 100) sits above the lightbox (z-index 60).
- `ChatMode` calls `closeWorkerLightbox()` on unmount. The lightbox state lives in the shared
  Overseer store; without this, a thread opened in Chat would reopen over Overseer or the board.
- Q3: an "Open in Workspace" button in the lightbox header, shown only when the caller passes
  an `onOpenFull` prop (Chat passes it; Overseer and the board do not). Recommended, because a
  CLI thread is easier to use full size. If the owner says no, the lightbox is used unchanged.

## 4. Data and API changes

### 4.1 Core

- `buildWorkerCreateBody` (`packages/core/src/overseer/worker-payload.ts`) takes an optional
  `spawnedBy` and writes it into `config` (omitted when empty, so old bodies stay
  byte-identical). `WorkerSpec` and `createWorker` (`agency-shared.ts`) pass it through.
- `agency-mcp.ts` `spawnAgent` and `queueAgent` pass `spawnedBy: callerTerminal()`.
- New file `packages/core/src/endless/pane.ts`, pure apart from its DB reads:

```ts
export interface PaneThread {
  id: string;
  project: string;                 // sessions.id
  label: string;
  harness: string;                 // terminals.type, e.g. claude-code, codex
  state: 'working' | 'needs_you' | 'queued' | 'error' | 'done' | 'idle';
  startedBy: 'chat' | 'overseer' | 'thread' | 'role' | 'user';
  via: string | null;              // parent label for startedBy 'thread', or a Chat parent
  startedAt: string;               // terminals.created_at
  lastActivityAt: string | null;
  question: string | null;         // needs_you only, max 280 chars
}
export function collectPaneThreads(db, opts: { now: number; timeZone: string; question: (id: string) => string }): { threads: PaneThread[]; truncated: boolean };
```

  `done` is an idle `role: 'agent'` or Chat thread; `idle` is an idle owner thread. The
  status mapping is: `working` to working, `needs_input` to needs_you, `queued` to queued,
  `error` to error, `waiting` to done or idle.
- `EndlessService.projects()` returns `{ projects: ProjectStatus[], threads: PaneThread[],
  truncated: boolean }`. `question` uses the existing private `waitingText`.
- `collectProjects` and `buildStatusBlock` do not change. The model's per-turn input stays
  byte-identical.

### 4.2 Wire

`GET /api/endless/projects` changes from `ProjectStatus[]` to the object above. The only
client is the web store, which ships in the same build. The web client accepts both shapes
for one release (an array means "no threads"), so a cached old page or a newer page against an
older daemon does not break.

### 4.3 Web

- `api/types.ts`: `EndlessPaneThread`, the new response type.
- `stores/endless.ts`: `threads`, `truncated`, `watch()`, `unwatch()`, the debounced reload,
  the timer, the visibility listener, the event filter (section 3.1).
- A selector `threadState(id)`: the pane row merged with the `useThreadStatus` overlay. The
  pane rows and the "Started" chip both use it.

## 5. Events summary

| Event | Source | Pane effect |
|---|---|---|
| `terminal:created` | `routes/terminals.ts` | reload (debounced) |
| `terminal:status`, coarse status changed or thread unknown | `status/service.ts` | reload (debounced) |
| `terminal:status`, activity only | `status/service.ts` | no reload; row line 2 updates from `useThreadStatus` |
| `terminal:exit`, `terminal:removed` | `status/service.ts`, `routes/terminals.ts` | reload (debounced) |
| `endless:message` kind `work` | Chat service | reload (as today) |
| `endless:message` kind `tool` or `echo` | Chat service | the "Started" item draws (no reload) |
| `endless:turn` end | Chat service | reload (as today) |
| 60 s timer, page visible | web | reload |
| `visibilitychange` to visible, socket reconnect | web | reload |

## 6. UI

### Desktop

```
 Projects                         [refresh]
 ── Needs you ─────────────────────────────
 | ● Review PR 91 (Codex)          14:02
 |   dispatch · Overseer · Codex
 |   "Merge now or wait for CI?" (options: Merge | Wait)
 ── dispatch ──── 2 live · 1 need you · 3 open
   ● Fix review findings            13:40
     Chat · Claude · Running: npm test
   ● Re-review PR 91                13:55
     Overseer · Codex · Editing reports.ts
   ▸ Done today (3)
 ── other-project ─ 0 live · 0 need you · 2 open
```

The pane stays 280 px. Rows are 2 lines (3 for a question). Touch targets are at least 44 px
high on mobile.

The "Started" item in the chat column:

```
 ▸ Started  Fix review findings · dispatch · Claude   ● working
```

### Mobile (iPhone Safari PWA)

- The Projects sheet shows the same panel. The toolbar button shows the need-you badge.
- A row tap closes the sheet, then opens the lightbox (near full screen, safe-area top
  padding, already built for `OverseerMobile`).
- "Started" items and report cards open the lightbox directly.
- The lightbox close button returns to the same chat scroll position (the chat column does
  not unmount).

## 7. Tests (tests first)

Each test below is written before its code. "Fails first" means it must fail on
origin/main 91b15fdd.

### Core (`packages/core/tests/...`, except where a full path is given)

| Test | Checks | Fails first |
|---|---|---|
| `packages/core/src/overseer/worker-payload.test.ts` (new cases) | `spawnedBy` lands in `config`; an empty one is omitted and the old body is byte-identical | yes |
| `endless/pane.test.ts` (new) | the quiet rule (working any age, done only today, archived and file tabs and the coordinator left out); the order; the 6 per project and 60 total caps with `truncated`; the state mapping; each `startedBy` rule including missing `spawnedBy` and a Chat parent; `question` only for needs_you, cut to 280 | yes (no module) |
| `routes/endless.test.ts` (new case) | `GET /projects` returns `{ projects, threads, truncated }` | yes |
| `endless/status-block.test.ts` (existing) | the status block text is unchanged | no (guard) |
| `overseer/agency-mcp.test.ts` (new cases) | `spawn_agent` and `queue_agent` send `spawnedBy` equal to `DISPATCH_TERMINAL` | yes |

### Web (`packages/web/src/...`)

| Test | Checks | Fails first |
|---|---|---|
| `foldRows` (in `EndlessColumn.test.tsx` or a new `EndlessMessageRow.test.tsx`) | tool A, tool B, echo A, echo B pairs A with echo A and B with echo B; a tool with no echo yet stays alone; the run-of-1 case is unchanged | yes |
| Started item | a spawn tool row alone shows "Starting"; with a JSON echo shows "Started" and the label; a non-JSON echo shows "Could not start"; a tap calls `drillInto(agentId)` and does not change the view | yes |
| Started chip | a `terminal:status` event changes the chip from working to needs you with no reload | yes |
| `stores/endless.test.ts` | while watched: `terminal:created` reloads once after the debounce; 5 events in 100 ms give 1 reload; an activity-only status gives none; not watched gives none; the 60 s timer; `visibilitychange`; both response shapes parse | yes |
| `ProjectsPanel.test.tsx` | the Needs you section comes first with the question; rows show name, origin, harness, time; Done today folds; "+N more"; a row tap awaits `loadTabs` when the project is not loaded, then calls `drillInto`; on mobile the sheet closes first | yes |
| report card | the short card and "Open thread" open the lightbox; `setView` is not called | yes |
| `ChatMode` | mounts the lightbox inside `.overseer-root`; unmount calls `closeWorkerLightbox` | yes |
| `WorkerLightbox` (only if Q3 is yes) | "Open in Workspace" shows only with `onOpenFull` | yes |

### End to end

The `/verify` skill: an isolated daemon (fake HOME, port 3999, never the real `~/.dispatch`).
Start a Chat turn that spawns two threads in parallel. Check that the "Started" items show
before the turn ends, the pane lists both within 1 s, a thread that asks a question moves to
Needs you with its question, and the lightbox opens from all three places. Then a headless
Chrome run at iPhone size for the sheet, the badge, and the lightbox.

## 8. Risks

| Risk | Mitigation |
|---|---|
| `terminal:status` fires on many hook events, so the pane reloads too often | Reload only on a coarse status change, debounce 600 ms, one in flight; activity reads from the existing overlay |
| The "Started" item depends on the tool name and the echo JSON shape of `spawn_agent` | A core test already pins the echo shape (`packages/core/tests/endless/memory-mcp.test.ts:64`); the item falls back to "Could not start" with the raw text when parsing fails |
| The `foldRows` change touches every tool row | The run-of-1 case is tested unchanged; runs only form from consecutive tools |
| Shared Overseer store: a lightbox opened in Chat shows up in Overseer | `closeWorkerLightbox()` on ChatMode unmount |
| Lightbox under the mobile sheet (z-index 60 vs 100) | Close the sheet before opening |
| A CLI thread opens as an empty chat when its project's tabs are not loaded | `openThreadInPlace` awaits `loadTabs` first |
| `question` reads a transcript (`finalOutput`) when there is no pending prompt | Only for needs-you threads, which are few; cut to 280 chars |
| Old peer-spawned rows show "Overseer" | They leave the list at midnight; new rows carry `spawnedBy` |
| iOS pauses timers and the socket in the background | Reload on `visibilitychange` and on socket reconnect |
| Scope creep toward Overseer | Non-goals in section 1; rows have no controls; no ledger in the pane |

## 9. Later (not in this PR)

- A "Sent to thread name" item for `message_thread`, drawn the same way as "Started".
- A saved latest step per thread, so it survives a reload.
- A dedicated `endless:threads` diff event instead of a reload.
- Filters in the pane (by origin, by project).
- Thread names in the model's status block.
- Enforcing the behavior rule with `--disallowedTools` for the Task and Agent tools in Chat
  turns (Q7).

## 10. Open questions (each with a recommended answer)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Which finished threads show? | Finished today (local midnight, daemon time zone), folded under "Done today (N)" per project. Older ones are in the Work tab |
| Q2 | Does the project's own Overseer coordinator thread show as a row? | No. It is almost always active and would fill the list. Its open items stay in the counts, and Overseer shows it |
| Q3 | Add an "Open in Workspace" button to the lightbox when Chat opens it? | Yes, behind an optional `onOpenFull` prop, so Overseer and the board do not change |
| Q4 | Does `message_thread` also get a chat item ("Sent to ...")? | Not now (section 9). Start with "Started" only and see if it helps |
| Q5 | Under a project filter, show a "Started" item by the turn's tag or by the target project? | The turn's tag (no core change). Showing it by target would need a per-row project override in the store |
| Q6 | Give the model the thread list too (in the status block)? | No. It changes the model's input every turn and Chat already has `list_threads` |
| Q7 | Enforce "real threads only" in code (disallow Task and Agent in Chat turns)? | Not in this PR. Keep it as a rule in the Chat instructions; revisit only if a private agent run is seen |
| Q8 | Make the pane wider than 280 px? | No. Two-line rows fit; the chat column keeps its width |

## 11. Task breakdown (for the later plan)

One PR, in this order. Each task is tests first, then code, then one commit.

1. **Core: record the spawner.** `spawnedBy` in `buildWorkerCreateBody`, `WorkerSpec`,
   `createWorker`, and the agency `spawnAgent` and `queueAgent`. Tests: worker payload, agency
   spawn.
2. **Core: pane threads.** `endless/pane.ts`, `EndlessService.projects()` new shape, the route.
   Tests: `pane.test.ts`, route case, status block guard.
3. **Web: store.** Types, both response shapes, `watch` and `unwatch`, the event filter,
   debounce, timer, visibility, reconnect, `threadState`. Tests: `stores/endless.test.ts`.
4. **Web: tool runs and the "Started" item.** `foldRows` run pairing, `StartedItem` in
   `EndlessMessageRow.tsx`. First check the parallel result order with a real two-spawn turn
   (section 3.4). Tests: fold, Started states, live chip.
5. **Web: open in place.** `openThread.ts`, the lightbox mount and unmount close in
   `ChatMode`, the report card switch, and `onOpenFull` if Q3 is yes. Tests: report card,
   ChatMode, lightbox prop.
6. **Web: the pane.** Needs you section, project blocks, rows, Done today fold, "+N more",
   toolbar badge, mobile sheet close. Tests: `ProjectsPanel.test.tsx`.
7. **Verify.** The touched test files, then the full suite once; `/verify` end to end; a
   headless Chrome check at iPhone size. A short build record in the PR.

Estimated size: about 250 lines of core code, 450 of web code, and the tests.
