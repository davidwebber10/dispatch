# Chat thread visibility: design

Date: 2026-10-19
Status: approved by Jason on 2026-10-19, with every decision recorded below. Next: the visual
design review in Claude Design (section 13 and the design brief), then an in-app preview page
(section 14), then the implementation plan.
Base: origin/main 91b15fdd (v3.1.7)
Parent spec: `2026-10-13-endless-chat-design.md` (called "the Chat spec" below)

## Decisions (approved by Jason, 2026-10-19)

Jason approved this spec on 2026-10-19 and accepted the recommended answer to every question.
No question is open. Section 10 lists all of them (Q1 to Q17).

| ID | Decision |
|---|---|
| CTV-Q1 | Finished threads show folded: finished today only, under "Done today (N)" per project |
| CTV-Q2 | No row for a project's own Overseer thread. Its open items stay in the counts; Overseer shows the thread |
| CTV-Q3 | "Open in Workspace" appears in the thread viewer only when Chat opens it, behind an optional prop; Overseer and the board do not change |
| CTV-Q7 | "No private agents" (Task, Agent) is a written rule in the Chat instructions only, with no code behind it |
| CTV-NAMES | The committed `2026-10-19-chat-thread-visibility-design-brief.md` keeps the neutral project names, because the repository is public. The copy with the real names, `2026-10-19-chat-thread-visibility-design-brief.local.md`, stays git-ignored and is never committed |
| Q4 to Q6, Q8 to Q17 | The recommendations exactly as written in section 10 |

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
7. Spec and plan files named in Chat open in place, from the right copy (main, a worktree or
   an unmerged branch), with Reveal in Finder on the Mac and a per-project Docs list
   (section 12).

The owner approved all six items. Item 4 is the owner's favorite. The in-place lightbox and
item 7 are the owner's additions.

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
The owner keeps the rule in the Chat instructions setting. Decided (Q7): no code enforces it.

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
- Decided (Q3): an "Open in Workspace" button in the lightbox header, shown only when the
  caller passes an `onOpenFull` prop (Chat passes it; Overseer and the board do not), because
  a CLI thread is easier to use full size.

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
| `WorkerLightbox` (Q3) | "Open in Workspace" shows only with `onOpenFull` | yes |

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
- Doc links inside the thread lightbox open the doc viewer, not a file tab (Q13).
- Close the absolute-path gap in `GET /api/sessions/:id/files/read` (section 12.1). It is a
  separate fix with its own review.

## 10. Decided questions (approved by Jason, 2026-10-19)

Jason accepted every recommended answer on 2026-10-19. Each answer below is now the decision.

| # | Question | Decision |
|---|---|---|
| Q1 | Which finished threads show? | Finished today (local midnight, daemon time zone), folded under "Done today (N)" per project. Older ones are in the Work tab |
| Q2 | Does the project's own Overseer coordinator thread show as a row? | No. It is almost always active and would fill the list. Its open items stay in the counts, and Overseer shows it |
| Q3 | Add an "Open in Workspace" button to the lightbox when Chat opens it? | Yes, behind an optional `onOpenFull` prop, so Overseer and the board do not change |
| Q4 | Does `message_thread` also get a chat item ("Sent to ...")? | Not now (section 9). Start with "Started" only and see if it helps |
| Q5 | Under a project filter, show a "Started" item by the turn's tag or by the target project? | The turn's tag (no core change). Showing it by target would need a per-row project override in the store |
| Q6 | Give the model the thread list too (in the status block)? | No. It changes the model's input every turn and Chat already has `list_threads` |
| Q7 | Enforce "real threads only" in code (disallow Task and Agent in Chat turns)? | Not in this PR. Keep it as a rule in the Chat instructions; revisit only if a private agent run is seen |
| Q8 | Make the pane wider than 280 px? | No. Two-line rows fit; the chat column keeps its width. The visual design review (section 13) can change this |
| Q9 | How does "Open in editor" work, and which editor? | An editor URL opened by the browser (`vscode://file`, or the Cursor or Zed form), picked in the Chat settings, empty by default so the button is hidden. No daemon process, desktop only |
| Q10 | Which file types become links? | `.md`, `.markdown` and `.txt`. Other files stay plain text |
| Q11 | Fetch remote branches before a branch read? | No. Read them as of the last fetch and say so in the viewer |
| Q12 | Which folders does the Docs list scan? | `docs/superpowers/specs`, `docs/superpowers/plans`, `docs/specs`, `docs/plans`. Not every `.md` in the repo |
| Q13 | Should doc links inside the thread lightbox (a thread's own chat) open the doc viewer too? | Later. Today they open a file tab; changing the shared `ChatView` is a separate change |
| Q14 | Where does the "report doc paths" rule live? | One sentence in the shared worker prompt in `prompts.ts`, for all agent types, so Overseer and Chat threads both follow it |
| Q15 | A path inside a removed worktree with no branch named: what opens? | The branch whose name ends in the worktree name, else the main checkout copy with a note, else "not found" |
| Q16 | One PR or two? | Two, in one plan: PR 1 is items 1 to 6, PR 2 is item 7 (doc links), built on PR 1. Each stays reviewable |
| Q17 | Keep the in-app preview page after the build? | No. Delete it in the last build task; its fixtures would drift from the real data (section 14) |
| CTV-NAMES | Which project names does the committed design brief use? | Neutral names, because the repository is public. The real-name `.local.md` copy stays git-ignored (section 13) |

## 11. Next steps and task breakdown

The owner set this order on 2026-10-19:

1. The owner reviews this spec.
2. Visual designs of every changed screen (section 13). The owner pastes the design brief
   `2026-10-19-chat-thread-visibility-design-brief.md` into Claude Design and reviews the
   output.
3. An in-app preview page on the spec branch (section 14): the approved designs built with the
   real components and fixture data, so the owner sees them in the real app before the build.
   It starts only after the owner reviews the Claude Design output.
4. Only then the implementation plan and the code. The plan follows the approved designs and
   the preview where they differ from this spec.

The rough task order for that plan is below. Each task is tests first, then code, then one
commit. Tasks 1 to 7 are PR 1; tasks 8 to 12 are PR 2 (Q16).

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
   `ChatMode`, the report card switch, and the `onOpenFull` prop (Q3). Tests: report card,
   ChatMode, lightbox prop.
6. **Web: the pane.** Needs you section, project blocks, rows, Done today fold, "+N more",
   toolbar badge, mobile sheet close. Tests: `ProjectsPanel.test.tsx`.
7. **Verify PR 1.** The touched test files, then the full suite once; `/verify` end to end;
   a headless Chrome check at iPhone size. A short build record in the PR.
8. **Core: doc resolver.** `docs/git.ts`, `docs/resolve.ts`, the `.worktrees/` and
   `git worktree list` step in `readSourceFile`, the `/api/endless/doc` route. Tests: resolve,
   safety, source-file, route.
9. **Core: Docs list and the report rule.** `docs/list.ts`, `/api/endless/docs`, the worker
   prompt sentence. Tests: list, route, prompts.
10. **Web: links.** `lib/docPaths.ts`, the `docs` pass in `Markdown`, report card and
    "Started" task links. Tests: docPaths, Markdown.
11. **Web: viewer and Docs list.** `DocViewer`, `useDocViewer`, the editor setting, Reveal,
    Copy path, the Docs fold in `ProjectsPanel`. Tests: DocViewer, ProjectsPanel.
12. **Verify PR 2.** Same as task 7, with the three-copy fake project (12.9).

Estimated size: PR 1 about 250 lines of core code and 450 of web code; PR 2 about 350 of core
and 350 of web; plus the tests.

## 12. Open spec and plan files from Chat (item 7, added 2026-10-19)

The owner added this item after the first draft: "i need a way to open plan files from here.
it would be great if they were direct linked to the file in the folder structure. finding
them in worktrees is a pain."

### 12.1 Current behavior (verified in code)

| Area | Today | Where |
|---|---|---|
| Paths in chat text | Not linked. Dispatch replies render through `InsightText` and `Markdown`; report cards render plain text. No path becomes a link | `packages/web/src/components/endless/EndlessMessageRow.tsx:110-140`, `packages/web/src/components/InsightText.tsx` |
| File links elsewhere | "View file" on tool rows opens a FILE tab (`openFileTab`), which leaves the current surface | `packages/web/src/lib/openFileTab.ts`, `packages/web/src/components/tabs/chat/ChatView.tsx:221-226` |
| A safe doc reader | `readSourceFile` (the Overseer source panel): the real path must stay inside the project folder, symlinks resolved; `.md` and `.markdown` only; 5 MB cap; a missing path is looked for in worktrees (newest copy wins) and a gone worktree falls back to the main checkout, each with a note | `packages/core/src/overseer/source-file.ts` |
| Its gap | It knows worktrees only under `.claude/worktrees/`. This owner's convention is `.worktrees/` (this spec's own worktree). It never reads a branch that has no worktree | `source-file.ts:66`, `:144-157` |
| Markdown renderer | `Markdown` renders with DOMPurify, then runs a text-node pass after the sanitizer (the ledger chips), with one delegated click handler | `packages/web/src/components/Markdown.tsx:46-60` |
| Reveal in Finder | `POST /api/sessions/:id/files/reveal` exists. It works only when the browser runs on the Mac itself (loopback socket, no proxy headers). The web app reads `canReveal` from `/api/state` | `packages/core/src/routes/files.ts:304-325`, `packages/core/src/routes/state.ts:165-179`, `packages/web/src/stores/host.ts` |
| Open in editor | Nothing exists | |
| A read route NOT to reuse | `GET /api/sessions/:id/files/read` accepts any absolute path (`resolveRead`), so it can read outside the project. The new route must not call it. Closing that gap is a separate item (section 12.9) | `packages/core/src/routes/files.ts:88-98`, `:195-208` |

### 12.2 Doc links in chat

- **What becomes a link:** a path that ends in `.md`, `.markdown` or `.txt` (Q10), as a bare
  word or in inline code, in three places: Dispatch replies (`unii`), report cards (`work`),
  and the task text of a "Started" item (up to 2 links shown on the card, from the
  `spawn_agent` input). Tool rows stay plain. URLs (`http:`, `https:`) are never path links.
- **Which project:** an absolute path belongs to the registered project whose real folder
  contains it (longest match). A relative path uses the message's project tag. A relative
  path with no tag does not become a link.
- **How:** one pure function `findDocPaths(text)` returns the path spans. `Markdown` gets an
  optional `docs` prop: the same after-sanitizer text-node pass as the ledger chips wraps each
  span in a button (`data-doc-path`), and the delegated click handler opens the viewer. Report
  cards split their plain text with the same function. Trailing punctuation (`.`, `,`, `)`,
  `:`) is not part of the path.
- A link only opens; it never checks the file first. The viewer shows "not found" when the
  file is gone, so the chat never makes one request per path.

### 12.3 Resolving the right copy

A new core module `packages/core/src/docs/resolve.ts` grows from `readSourceFile` (it does
not fork it). Input: project id, path, and an optional branch name (from the text, see 12.6).
The first match wins:

1. **The path on disk.** An absolute path, or a relative path under the main checkout. The
   real path must be inside the project folder.
2. **Worktree copies.** The same relative path in each worktree inside the project folder,
   newest file first. Worktrees come from `git worktree list --porcelain`, kept to the ones
   whose real path is inside the project folder, plus the existing `.claude/worktrees/` scan
   for a non-git folder. So `.worktrees/` works and `.claude/worktrees/` keeps working.
3. **A path inside a gone worktree** (`.worktrees/name/rest` or `.claude/worktrees/name/rest`,
   the folder no longer exists): read `rest` at the named branch if the text gave one,
   else at the branch whose name ends in `name`, else the main checkout copy (today's note).
4. **Unmerged branches.** `rest` at the newest local or remote-tracking branch that has it and
   is not merged into the default branch, read with `git cat-file` (section 12.5).
5. Else "not found", with the places it looked.

The answer names the copy and how it compares to the default branch:

```ts
type DocCopy = {
  project: string;
  path: string;                    // relative to the checkout or worktree
  absPath: string | null;          // null for a branch-only read
  source: 'main' | 'worktree' | 'branch';
  worktree: string | null;         // folder name, e.g. chat-visibility-spec
  branch: string | null;           // e.g. spec/chat-thread-visibility, origin/spec/x
  vsMain: 'same' | 'changed' | 'not_on_main';
  modifiedAt: string;              // file mtime, or the branch commit date
  status: string | null;           // the doc's own "Status:" line, max 60 chars
  note: string | null;             // e.g. "the newest of 2 copies"
  markdown: string;
};
```

- **Default branch:** `origin/HEAD` if set, else `main`, else `master`.
- **vsMain:** `same` when the blob hash at the default branch equals the hash of this copy,
  `changed` when the default branch has the path with another hash, `not_on_main` when it
  does not have the path. The viewer says "changed here" for `changed`. It does not claim
  "newer", because the hash alone cannot tell which side is newer.
- **No fetch.** Remote-tracking branches are read as they are after the last fetch. The
  viewer says "as of the last fetch" for a remote branch (Q11).

### 12.4 The doc viewer

- `DocViewer` in `packages/web/src/components/endless/DocViewer.tsx`: `common/Modal`
  (a centered card on desktop, a sheet on mobile) around the app's `Markdown`. It is the same
  in-place pattern as the thread lightbox, but `common/Modal` already gives the mobile sheet,
  focus return and Escape, and it does not need the Overseer tokens.
- **Header:** the file name; a location chip ("main", "worktree chat-visibility-spec on
  spec/chat-thread-visibility", or "branch origin/spec/x, as of the last fetch"); the
  `vsMain` chip ("on main", "changed here", "not on main"); the doc's status line; the
  modified time; the note.
- **Actions:**

| Action | Shown when | Does |
|---|---|---|
| Reveal in Finder | `canReveal` is true and `absPath` is set | the existing reveal route, with the path made relative to the project folder |
| Open in editor | `canReveal` is true, `absPath` is set, and an editor is set (Q9) | opens an editor URL (`vscode://file` + the absolute path, or the Cursor or Zed form) in the browser; no daemon process |
| Copy path | always | copies `absPath`, or `branch:path` for a branch-only copy |
| Open the thread that wrote it | a writer is known (12.7) | the thread lightbox (section 3.6) |

- **Desktop only:** Reveal and Open in editor need the browser on the Mac, so they never show
  on the iPhone or on another computer. The server already decides this (`canReveal`), so
  the web app needs no device check of its own.
- **Mobile:** the viewer is a full-height sheet. Copy path stays. Links inside the doc to
  other `.md` files open in the same viewer, with a back button.
- **Stacking:** the viewer opens above the thread lightbox (Modal z-index 100 over 60), so a
  doc opened from a pane row inside the open lightbox is fine. Closing the viewer returns to
  what was below.

### 12.5 Safety (read-only)

- **Read only.** The new routes have no write, rename or delete path.
- **Only registered project folders.** Every path, after `realpath`, must be inside the
  folder of a registered project. A worktree is allowed only when its real path is inside
  that folder. A symlink that leads out is refused (`readSourceFile` rules).
- **No traversal.** A relative path is normalized; `..` that leads out is refused before any
  read. An absolute path outside every project folder is refused.
- **File types:** `.md`, `.markdown`, `.txt` only, checked on the path, and a regular file
  only (no folders, pipes or devices).
- **Size:** 2 MB cap for the viewer (the 5 MB source-panel cap stays for that panel). For a
  branch read, `git cat-file -s` checks the size before the content is read.
- **Branch reads:** the branch must be one that the server itself listed for that project
  (`git for-each-ref refs/heads refs/remotes`), so an input such as `--output=x` never
  reaches git. Git runs with `execFile` (no shell), `-C` the project folder, a 5 s timeout,
  and `--end-of-options` where the command takes it.
- **Rendering:** `Markdown` sanitizes with DOMPurify (unchanged). Relative images in a doc do
  not load (a known limit).

### 12.6 Threads report doc paths (rule)

Every spawned thread that writes or changes a doc names it in its final report as an absolute
path and a branch, on its own line:

```
Doc: /abs/path/to/project/.worktrees/name/docs/superpowers/specs/file.md (branch spec/name)
```

- This is one sentence added to the shared worker prompt for all agent types in
  `packages/core/src/overseer/prompts.ts` (next to the Planner text at `:454`), so Overseer
  and Chat threads both follow it. It changes prompt text only.
- `findDocPaths` reads the `(branch ...)` part, and the resolver uses it in step 3 when the
  worktree is gone.
- Links still work without the line (relative paths and the worktree search). The rule makes
  the link exact and lets it survive a removed worktree.

### 12.7 Per-project Docs list in the pane

- Under each project block (section 3.2), after the threads: a "Docs (N)" line, closed by
  default. Opening it loads the list for that project only (lazy), from
  `GET /api/endless/docs?project=ID`.
- **What it lists:** `.md` files in `docs/superpowers/specs`, `docs/superpowers/plans`,
  `docs/specs` and `docs/plans` (Q12), from the main checkout, each worktree in the project
  folder, and each unmerged branch. For a branch, only the doc files that the branch added or
  changed against the default branch (`git diff --name-only default...branch` on those
  folders), newest 20 branches by commit date.
- **One row per path:** the newest copy wins; the row shows the other copies as a count.
  Row: the file name, the doc's status line (for example "draft, awaiting owner review"),
  the location chip, the `vsMain` chip, the modified time, and the writer.
- **The writer:** the newest non-archived thread whose working folder is that worktree; else
  the thread (`ref`) of the newest Chat report that names the path; else none. A writer tap
  opens the thread lightbox; a row tap opens the viewer.
- **Order and caps:** newest first; 8 rows, then "+N more". The server caches the list for
  60 s per project, keyed by the worktree list and the branch heads, so a reopen is cheap.

### 12.8 Data and API changes

| Route | Returns |
|---|---|
| `GET /api/endless/doc?project=ID&path=P&branch=B` | `DocCopy`, or 404 with the places it looked, or 403 for a refused path |
| `GET /api/endless/docs?project=ID` | the doc rows of 12.7 |

Core: `packages/core/src/docs/resolve.ts` (12.3, 12.5), `packages/core/src/docs/list.ts`
(12.7), `packages/core/src/docs/git.ts` (a small `execFile` wrapper: worktrees, refs, blob
hash, size and content). `readSourceFile` gains the `git worktree list` step and the
`.worktrees/` form, so the Overseer source panel finds the same copies (its tests must stay
green).

Web: `findDocPaths` in `packages/web/src/lib/docPaths.ts`; the `docs` prop on `Markdown`;
`DocViewer`; a `useDocViewer` store (open path, history for back); the editor choice in the
Chat settings (Q9); the Docs fold in `ProjectsPanel`.

### 12.9 Tests (tests first)

Core tests build their git repos in a nested temp folder made for each test, never in a
shared folder, and never touch the real HOME.

| Test | Checks | Fails first |
|---|---|---|
| `docs/resolve.test.ts` (new) | main copy; a `.worktrees/` copy and a `.claude/worktrees/` copy (newest wins, with the note); a gone worktree read at the named branch; an unmerged branch read; `vsMain` same, changed, not_on_main; the status line | yes (no module) |
| `docs/resolve.test.ts`, safety cases | `../` out, an absolute path outside every project, a symlink out, a worktree outside the project folder, a branch the server did not list, a branch named like an option, a folder, a `.json` file, a file over 2 MB, a branch blob over 2 MB | yes |
| `docs/list.test.ts` (new) | the four folders only; one row per path with the newest copy; only added or changed files for a branch; the writer from a worktree thread and from a Chat report; the 60 s cache | yes |
| `overseer/source-file.test.ts` (existing plus new) | the old cases unchanged; a `.worktrees/` copy is found | the new case, yes |
| `routes/endless.test.ts` (new cases) | the two routes; 403 and 404 bodies | yes |
| `overseer/prompts.test.ts` (new case) | the worker prompt has the doc report rule | yes |
| `lib/docPaths.test.ts` (new, web) | bare and inline-code paths; trailing punctuation; URLs left alone; the `(branch ...)` part; `.md`, `.markdown`, `.txt` only | yes |
| `Markdown.test.tsx` (new cases) | the `docs` pass makes buttons after the sanitizer; a path inside a link or code block is still sanitized | yes |
| `DocViewer.test.tsx` (new) | the chips for each `source` and `vsMain`; Reveal and editor hidden when `canReveal` is false; Copy path; not found; back after a link inside the doc | yes |
| `ProjectsPanel.test.tsx` (new cases) | Docs fold closed by default, loads once on open, rows, writer tap opens the lightbox | yes |

End to end (`/verify`): a fake project with a main checkout, a `.worktrees/` worktree and a
spec branch with no worktree. A Chat report that names each copy opens the right one;
Reveal works in a local browser and is hidden at iPhone size.

### 12.10 Risks

| Risk | Mitigation |
|---|---|
| A new read route becomes a way to read any file | The 12.5 rules, the safety test cases, and no use of `/files/read` |
| Git calls are slow on 18 projects with many branches | The list is lazy per project, capped at 20 branches, cached 60 s; a single doc read is a few `git cat-file` calls |
| False links (a word that looks like a path) | Only the three file types; a relative path needs a project tag; a bad link only shows "not found" |
| The wrong copy opens when several exist | The newest copy wins, and the header always says which copy and how many there are |
| Remote branches are stale | No auto fetch; the viewer says "as of the last fetch" |
| The editor URL does nothing when that editor is not installed | The editor is a setting, empty by default, so the button is hidden until the owner picks one |
| `readSourceFile` changes affect the Overseer source panel | Its existing tests stay; only one lookup step is added |
| The existing `/files/read` absolute-path gap | Out of scope here; list it as its own fix |

## 13. Screens to design

The owner reviews visual designs of these screens before the plan (section 11). The brief
for the designer is `2026-10-19-chat-thread-visibility-design-brief.md`. It uses neutral
project names, because the repository is public. A copy with the owner's real project names,
`2026-10-19-chat-thread-visibility-design-brief.local.md`, sits next to it and git ignores
it (`*.local.md` in `.git/info/exclude`). The designs show the look only; this spec stays the
source for the behavior.

| # | Screen | Real component | Data it shows | States to design |
|---|---|---|---|---|
| S1 | Right pane, per project | `packages/web/src/components/endless/ProjectsPanel.tsx`, in the 280 px aside of `ChatMode.tsx` | `ProjectStatus` counts (live, need you, open); `PaneThread` rows: name, state, harness, who started it, start time, latest step, question | loading (first load); empty ("No project activity yet"); unavailable (Chat is starting); the Needs you section first, with the question; a project block with working, queued and error rows; each who-started tag (Chat, Overseer, You, Role, "via" a thread); "Done today (N)" closed and open; "+N more"; a project with only open items; the truncated note |
| S2 | Toolbar Projects button | `ChatMode.tsx` | the need-you count | no badge; badge with a count |
| S3 | "Started" card in the chat | `packages/web/src/components/endless/EndlessMessageRow.tsx` (new `StartedItem`) | thread label, project, harness, live state, up to 2 doc links from the task | Starting (no result yet); Started with each chip (working, needs you, done, error); no chip (an old thread); Could not start; the card among tool rows, and the same thread's report card later in the chat |
| S4 | Report card with doc links | `EndlessMessageRow.tsx` (`WorkCard`) | the report text and its doc paths | short card; folded; open with "Open thread" and doc link chips |
| S5 | Thread viewer opened from Chat | `packages/web/src/components/overseer/components/WorkerLightbox.tsx` (reused), mounted in `ChatMode.tsx` | the thread's own chat or terminal, its header and controls | over the chat on desktop; a waiting thread with its question; the "Open in Workspace" button (Q3). Do not redesign the lightbox itself |
| S6 | Doc link chip | `packages/web/src/components/Markdown.tsx` (new `docs` pass), `EndlessMessageRow.tsx` | the file name; the full path on hover | in a Dispatch reply (bare path and inline code); in a report card; a long absolute path; hover and focus |
| S7 | Doc viewer | new `packages/web/src/components/endless/DocViewer.tsx` in `common/Modal` | `DocCopy`: file name, location, `vsMain`, status line, modified time, note, the rendered Markdown | from main, same as main; from a worktree, changed here; from a worktree, not on main; branch only, as of the last fetch; actions on the Mac (Reveal in Finder, Open in editor, Copy path, the writer thread) and elsewhere (Copy path only); loading; not found; refused; too large; back after a link inside the doc |
| S8 | Per-project Docs list | `ProjectsPanel.tsx` (the Docs fold) | doc rows: file name, status line, location, `vsMain`, modified time, writer thread, other copies count | closed ("Docs (N)"); loading; rows; empty; "+N more" |
| S9 | Mobile (iPhone Safari PWA) | `ChatMode.tsx` (the Projects `Modal` sheet), `packages/web/src/components/mobile/MobileApp.tsx` | the same as S1 to S8 | the Projects sheet with the S1 states and S8; the toolbar badge; a "Started" card at 393 px; the thread viewer as a sheet; the doc viewer as a sheet with Copy path only |

## 14. In-app preview page (after the design review, before the build)

Step 3 of section 11. Not started: it begins only after the owner reviews the Claude Design
output. No code exists for it yet. Outline:

- **Route:** `/preview/chat-visibility`, in the web app only.
- **Dev only:** the page is loaded through a dynamic import behind `import.meta.env.DEV`, so
  `pnpm --filter web dev` (Vite) serves it and the production build leaves it out. The
  daemon never serves it, so it never reaches an installed Dispatch.
- **Fixture data:** one file, `packages/web/src/preview/chat-visibility.fixtures.ts`, with the
  brief's sample data (section 4 of the brief, neutral names). The page fills the stores
  (`useEndless`, `useThreadStatus`, `useTabs`, `useHost` for `canReveal`) from it and stubs the
  API calls, so it needs no running daemon.
- **Real components:** the page renders `ChatMode`'s parts with the new components as they
  will ship (`ProjectsPanel`, `StartedItem`, `WorkCard`, `DocViewer`, `WorkerLightbox` in its
  `.overseer-root` wrapper). The components it shows are the first build of tasks 4 to 6 and
  10 to 11, kept behind fixtures until the plan wires them to live data.
- **Screens:** S1 to S9 from section 13. A small bar at the top switches the state of each
  screen (for example loading, empty, needs you, Done today open) and the width (desktop, or
  a 393 px frame for the iPhone).
- **Where it lives:** commits on a branch from `spec/chat-thread-visibility`, so the spec and
  the preview stay together until the owner approves both. No PR, no merge into main.
- **Decided (Q17):** the last build task deletes the preview page, because its fixtures
  would drift from the real data and nothing tests them.
