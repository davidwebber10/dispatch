# Phone Threads view: filter by who started the thread (Mine / Agents / All)

Date: 2026-11-05. Status: draft for the owner. Scope: web app only (packages/web). No server change.

## 1. The problem

The phone app has a Projects tab with a Projects ⇄ Threads switch. The Threads view
(`AllThreadsView.tsx`) lists every open thread of every project, newest activity first. It hides
file tabs and archived threads, but nothing else.

Most of the threads in that list are threads that an agent started: review threads, fix threads,
overseer workers, and children of other threads. The owner cannot find the threads that they
started by hand.

Live counts from this Mac (read-only query on 2026-11-05; open threads in open projects, file
tabs excluded, which is the set the Threads view shows):

| Who started the thread | All open | Active in the last 7 days |
|---|---:|---:|
| The owner: a plain thread | 67 | 13 |
| The owner: a project's overseer tab | 15 | 4 |
| The owner: a shell | 8 | 0 |
| **Mine, total** | **90 (12%)** | **17** |
| Chat | 140 | 53 |
| A thread that Chat started (older rows with no Chat mark) | 67 | 6 |
| Another thread | 27 | 21 |
| An overseer (marked) | 7 | 1 |
| An overseer, or unknown (old rows with no starter id) | 432 | 0 |
| A scheduled role run | 0 | 0 |
| **Agents, total** | **673 (88%)** | **81** |

So 9 of 10 rows in the list are agent threads. In the last week, 81 of 98 active rows were agent
threads.

## 2. What the other screens do today

- The desktop sidebar and the phone's own project screen (`ProjectCard.tsx`) already hide every
  agent thread. Their rule is "hide a row that is a coordinator or that has `config.agentType`".
  All 673 agent rows have `agentType`, and no owner row has it. So those screens already show
  "Mine" only.
- The Chat pane's project list (`endless/ProjectsPanel.tsx`) already shows a "started by" word
  on each row: You, Chat, Overseer, Role, or "via" a thread name. The server computes it in
  `packages/core/src/endless/pane.ts` (`startedByOf`).

So the gap is only the phone's cross-project Threads view. It is the one list that mixes
both kinds of thread.

## 3. Where "started by" comes from

There is no `created_by` column on threads. The SEC-20 `created_by` column exists only on
integrations and schedules. The thread record is the `terminals` row, and its `config` JSON holds
the facts. The web app already gets the whole `config` in every thread list (`Terminal.config`).

| Field in `config` | Who writes it | What it tells us |
|---|---|---|
| `role: 'agent'` | The server, for every thread made with a thread key or a Chat key (`auth/key-rules.ts`, `writeIdentity`). Before thread keys, the overseer and Chat tools set it in the create body. | An agent started this thread. |
| `role: 'coordinator'` | The overseer tab, which the owner opens. | The project's overseer tab. |
| `origin: 'endless'` | The server, for a thread that Chat started, and for every child of such a thread. | Chat started it, directly or through a chain. |
| `spawnedBy` | The server, from the caller's thread key. | The id of the thread that started this one. |
| `roleRun` | The scheduled role runner. | A scheduled role run. |
| none of these | A thread the owner made in the UI, a shell, or a branch of a thread (a branch keeps only `branchFrom`). | The owner started it. |

The Mine / Agents split needs only one test: `role === 'agent'`, or `origin === 'endless'`, or a
`roleRun` value, means Agents. All else means Mine. This test is the same as the first three
lines of `startedByOf` in `pane.ts`.

### Old threads

- Every agent row in the live database has `role: 'agent'`, back to the oldest one (2026-07-01).
  Across all 2,855 non-file, non-shell rows (archived rows too), no row has an agent mark
  (`mission`, `agentType`, `spawnedBy` or `origin`) without `role`. So the Mine / Agents split
  works for all old rows. There is no "unknown" bucket for this split.
- The finer label (Chat, Overseer, or which thread) has a gap: 432 old rows have no `spawnedBy`
  and no `origin`. `pane.ts` calls them "Overseer". Most are overseer workers, but some can be
  children of other threads from before `spawnedBy` existed. This affects only the optional label
  in section 6, not the filter.

### Known limits

- A caller with no key on this Mac (for example a shell that calls the API with plain curl) can
  make a thread with no `role`. That thread counts as Mine. This is rare, and the filter is a
  view aid, not a security control.
- A thread that Chat started because the owner asked Chat for it counts as Agents. See open
  question 2.
- If the owner types into an agent thread, it stays in Agents. See open question 3.

## 4. The filter

A three-way control: **Mine · Agents · All**.

- Mine: rows that the owner started (plain threads, overseer tabs, shells, branches).
- Agents: rows that Chat, an overseer, another thread, or a scheduled role started.
- All: the list as it is today.

Default: **Mine**. The owner asked for this view, and it is the view that is hard to get today.

The filter works together with the project chips and with the search box:

- The project chips show only projects that have at least one row in the current filter.
- The search box searches inside the current filter.
- When the current filter has no match, but the other filter has matches, the empty state says so
  and gives one button: "Show 4 agent threads" (or "Show 2 of my threads"). One tap switches the
  filter to All. So the owner never thinks that a thread is lost.

Each segment can show its count for the current project chip, for example "Mine 12". This is
cheap and tells the owner what each tap will show. (Optional; see open question 5.)

## 5. Where the control goes

Phone, Projects tab, Threads view only: a compact three-segment control in its own row, between
the Projects ⇄ Threads switch and the project chips. It uses the same look as the
Projects ⇄ Threads switch, but smaller (about 28 px high). The project chips row stays as it is.

Not on the phone's project screen, and not on the desktop sidebar. Those lists already hide agent
threads (section 2). A filter there would offer a choice that does nothing.

Desktop has no cross-project thread list, so there is nothing to change there now. If a desktop
"all threads" list comes later, it must use the same helper and the same filter.

## 6. Optional: a "started by" word on agent rows

In Agents and All, the second line of an agent row can show who started it, with the same words
as the Chat pane: "Chat", "Overseer", "Role", "via Fix login". Today that line shows the project
name (when no project chip is on). The new text goes after the project name: "Dispatch · Chat".

The helper finds the parent thread in the tabs store (the parent is always in the same project).
If the parent is not in the store, the word is "via a thread". Old rows with no `spawnedBy` show
"Overseer", as the Chat pane does. This part is separate from the filter and can ship later.

## 7. Is the choice remembered?

Yes, per device, in `localStorage` under `dispatch:mobileThreadsStarter` (values `mine`,
`agents`, `all`). This is the same way the Threads view keeps its project chip
(`dispatch:mobileThreadsProject`) and the Projects ⇄ Threads choice. A missing or bad value falls
back to Mine.

## 8. Server and API

No change. The thread lists that the Threads view loads already carry the full `config`. No new
column, no migration, and no backfill.

A server field (for example `startedBy` on each thread in the list) is not needed now. The web
helper copies three lines of logic. If a second client needs the same answer later, move the
logic to the server then.

## 9. Build

1. Add `packages/web/src/lib/startedBy.ts`: `isAgentStarted(config)` for the filter, and
   `startedByOf(terminal, findById)` for the optional row word. It mirrors
   `core/src/endless/pane.ts` `startedByOf`, with a comment that points to it. (The web app already
   copies small core types this way, for example `lib/creator.ts`.)
2. Change `AllThreadsView.tsx`: the three-segment control, the stored choice, the filter step
   before the project filter, the chip list from the filtered rows, and the empty-state button.
3. Optional, same PR or later: the row word (section 6) through the existing `subtitle` prop of
   `ThreadRow`.

## 10. Tests

Unit tests in `lib/startedBy.test.ts`, one case per row:

- plain thread (empty config) → Mine
- overseer tab (`role: 'coordinator'`) → Mine
- shell → Mine
- branch (`branchFrom` only) → Mine
- `origin: 'endless'` → Agents (Chat)
- `roleRun` set → Agents (Role)
- `role: 'agent'` with no `spawnedBy` → Agents (Overseer)
- `spawnedBy` = an overseer tab → Agents (Overseer)
- `spawnedBy` = a Chat thread → Agents (Chat, via its name)
- `spawnedBy` = a plain thread → Agents (via its name)
- `spawnedBy` = a thread not in the store → Agents (via a thread)
- bad or missing config → Mine, no throw

Component tests in `AllThreadsView.test.tsx`:

- The default is Mine. Agent rows are not in the list.
- Agents shows only agent rows. All shows every row, as today.
- The choice is stored and comes back after a remount. A bad stored value gives Mine.
- The project chips show only projects with rows in the current filter.
- Search works inside the filter.
- The empty-state button appears when only the other filter has matches, and it switches to All.
- The existing tests still pass. They must set All, or use owner rows, because the default
  changes.

Then the full web test suite once. A check in the phone app after the build: open the Threads
view, see Mine first, switch, close the app, open it again, and see the same choice.

## 11. Risks

| Risk | Effect | What we do |
|---|---|---|
| The default changes to Mine. | The owner opens the Threads view and does not see an agent thread that they expect. | The control is in view at the top. The empty-state button points to the other filter. The choice is remembered, so one tap to All fixes it for good. |
| A thread that the owner asked Chat to start counts as Agents. | The owner looks in Mine and does not find it. | Open question 2. Search plus the empty-state button covers it. |
| A no-key caller makes a thread with no role. | It counts as Mine. | Accept. Rare, and only a view issue. |
| The web copy of the rule drifts from `pane.ts`. | The Chat pane and the phone disagree on a row. | A comment in both files that points to the other. The test table covers every case. |
| Performance with about 760 rows. | None seen. The filter is one pass over rows that the view already sorts. | Nothing. |

Roll back: revert the web change. Nothing is stored on the server. The stored choice in the
browser becomes unused and harmless.

## 12. Size

Web only. 2 files changed and 2 files added (`AllThreadsView.tsx`, `AllThreadsView.test.tsx`,
`lib/startedBy.ts`, `lib/startedBy.test.ts`). About 60 to 100 lines of app code and 150 lines of
tests. About half a day with the review round. A patch release; the phone gets it on the next
update.

## 13. Open questions for the owner

1. Default filter: Mine (recommended) or All (no change until the owner taps)?
2. A thread that Chat started at the owner's request: Agents (recommended for now; it is the
   review and fix bulk), or Mine? A middle option is a fourth segment "Chat". We recommend against
   it now: 140 of the Chat rows are review and fix threads.
3. An agent thread that the owner typed into: keep it in Agents (recommended for now)? Moving it
   to Mine needs a new "the owner took over" mark on the server. Add it later if the owner misses
   such threads.
4. The "started by" word on agent rows (section 6): ship it in the same PR (recommended; small and
   uses the existing words from the Chat pane), or later?
5. Counts on the segments ("Mine 12 · Agents 80 · All 92"): yes (recommended) or no?
6. Remember the choice per device (recommended; same as the project chip) or one choice for all
   devices (needs a server setting)?
