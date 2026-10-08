# Overseer pinned recap card — design

Date: 2026-10-08. Status: design approved section by section by the user on 2026-10-08; this
written spec waits for the user's review. Thread "Opus 5.5 Xhigh Handle Business". Phase 2,
item 1 of the overseer recap work. Follows
`docs/superpowers/specs/2026-10-05-overseer-structured-recap-design.md` ("Phase 2"),
`docs/superpowers/specs/2026-10-06-overseer-decision-cards-design.md` and
`docs/superpowers/specs/2026-10-07-overseer-memory-scope-design.md`.

## Goal

The Control Plane screen shows the project's decision ledger as a live card that the web app
draws from the daemon's data. The user sees every open item, with its full context, without
reading a recap. The overseer's recap shrinks to news: what is new, what runs, what finished.
A ledger number never appears without its question.

## Decisions so far

1. **The card holds every ledger section; the recap becomes news** (user, 2026-10-08:
   "Q1: A"). Needs you now, Your tests and actions, Running on defaults, Decided since the
   last recap, Not yet triaged and Parked move to the card. The overseer stops pasting them.
2. **The card sits at the top of the right pane's Details tab**, above "Ongoing work"
   (user: "Q2: A").
3. **A click fills the message box; the user presses Enter** (user: "Q3: C"). The message
   stays the user's own message, so the daemon's quote check does not change. A merge, a
   deploy or a release still needs a message that the user sends.
4. **The 20-minute interim recap fires only when something new waits on the user**
   (user: "Q4: C2"). A finished agent alone does not trigger it. Reading, for review: "a new
   decision" includes every open item sent to the user since the last recap — `go`,
   `decide` and `do` — because a new manual step also waits on the user.
5. **Ledger numbers show as chips with the question** (user: "Q5: B"). The requirement in
   the user's words: "ensure that a ledger is referred to by at least one line of description
   text not just the number. i am only meat. i cannot retain all of these ledger numbers as a
   cross reference in my head."
6. **Structured data, drawn by the web app** (user: "go with 1"). The daemon computes the
   sections; the web app draws them, so every option is a real click target.
7. **Options as stacked rows in the pane** (user: "go with A"). Chat cards keep the
   Option | Effect table.
8. Design sections 1 to 4 approved (user: "yes it looks right", "yes this looks right",
   "yes this looks right").
9. **The cross-project "Needs you" view stays out of this spec.** It overlaps with the hidden
   thread Board (`docs/superpowers/specs/2026-07-20-thread-board-design.md`), whose owner is
   rethinking it. It is designed later, with that owner.

## Evidence

Recaps of four overseers from 2026-10-07 16:00 to 2026-10-08 20:30 UTC, compared with the
`ledger_list` text that each overseer had just received:

| Overseer | Recap length (characters) | Share that is pasted ledger text |
|---|---|---|
| A | 7,462 to 17,202 | 71% to 88% |
| B | 2,067 to 7,467 | 0% to 6% |
| C | 1,538 to 24,475 | 0% to 77% (77% was the import recap) |
| D | 713 to 14,116 | 0% to 62% (62% was the import recap) |

- Overseer A pastes the ledger, as the persona says. Most of each recap repeats the list.
- Overseers B, C and D rewrite the ledger in their own words. The recaps are short, but the
  rewrite drops the options and the defaults, against the persona's "paste as is", and it
  names items by bare numbers: "N11 and N52 are done", "(N4 to N6, N48)", "(N50)".
- Desktop has no "needs you" display at all today. `NeedsAlert` is mounted only on mobile
  (`OverseerMobile.tsx`).
- The interim timer arms only on a Finished notice while the batch is busy, and a recap or a
  settled batch clears it (`sessions/interim-recap.ts`). So when it fires, an agent has always
  finished since the last recap.

## Design

### Unit 1 — one sections function (core)

`ledger-render.ts` gets a pure function `ledgerSections(items, { now, lastRecapAt })`. It
returns the sections that `renderLedgerSections` builds today, as data:

- `rulesCount`;
- `needsYou`: `cards` (the new decisions first, then the top 5 of the rest: first the ones
  that hold up work, then the oldest) and `lines` (every other open decision);
- `onDefaults`, `actions` (open `do` items), `decidedSince` (answered or withdrawn since the
  last recap, then the overseer's own decisions since then), `untriaged` (`proposed`),
  `parked`;
- the counts that `renderCountLine` prints, and the set of items that count as new.

`renderLedgerSections` becomes a text render of `ledgerSections`. Its output does not change:
the existing tests pin it.

### Unit 2 — the read-only card route (core)

`GET /api/sessions/:sessionId/ledger/card` returns JSON:

- `updatedAt` and `lastRecapAt`;
- `sections` from Unit 1, each item as a card item: `seq`, `kind`, `status`, `text`,
  `context`, `options` (each `label`, `effect` and `answerKey`), `recommendation`, `why`,
  `default`, `source` (`kind`, `ref`, `section`, `id`), `blocks`, `mission`, `origin`,
  `sentAt`, `isNew`, `onDefaultSince`, `overseerNote`, the original question when the item
  supersedes another, and for decided items the choice and the quote or reason;
- `rules`: the project rules (quote and reading), for the read-only list;
- `index`: every item of the project, any status, as `seq`, `kind`, `status`, `text` and the
  answer when there is one. The chips (Unit 9) use it.

`answerKey` is the label's leading token when the label starts with one to three letters or
digits and a full stop (`A. 5 nights` gives `A`); otherwise it is the whole label.

The route only reads. It never stamps `lastRecapAt` and never clears the interim timer, so a
page load is never a recap. A project with no ledger returns empty sections. An unknown
session returns 404. The route has no caller check, like the routes that return
conversations: the network (loopback, Tailscale or Cloudflare Access) is the gate.

### Unit 3 — the `ledger:changed` event (core)

`LedgerService` takes an optional `onChange(sessionId)` callback and calls it after every
successful write: add, import, resolve, note, decide-self (both forms), add-from-agent,
mark-default, the agent `owner-decisions` capture, and `ledger_list` with `forRecap` (it
changes which items are new). `server.ts` wires both `LedgerService` instances (the router's
and the one inside `SessionService`) to
`broadcaster.broadcast({ type: 'ledger:changed', sessionId })` on the existing `/api/events`
socket. A failed broadcast never fails the write.

### Unit 4 — the interim recap only for something new (core)

When an overseer's interim timer is due and the batch is still busy, the sweep checks whether
an open `go`, `decide` or `do` item was sent to the user after `lastRecapAt`.

- Yes: it sends the interim notice, as today (delivery retry unchanged).
- No: it clears the timer without a notice. The next Finished notice arms it again.

The notice text says that new items wait on the user and asks for the short recap, marked
"interim".

### Unit 5 — the recap paste block and the persona (core)

`ledger_list({ forRecap: true })` returns two parts:

1. **"Paste this into the recap":** one line per new item (`N60 · Go · question · Rec: …`),
   one line per item decided since the last recap (the question and the answer), and one
   count line, for example `Needs you: 19 decisions, 8 actions — on the card.`
2. **"For your own use — do not paste":** the full ledger text of today, and the project
   rules.

`ledger_add` returns a one-line form for the chat (`N60 · Go · question — the full card is on
the pinned card`). `ledger_show` ("show N17", "show all") still returns full cards for the
chat.

Persona changes, for the Claude and the Codex persona:

- REPORTING: the recap is a header line; New (the pasted lines); Running (one line per agent,
  with what happens when it finishes); Done (finished work with PR numbers, and the decided
  lines). About 15 lines at most. Needs you now, actions, defaults and parked items stay on
  the card.
- A new question during a batch: record it with `ledger_add` and post the one line it
  returns.
- LEDGER NUMBERS (new rule): every ledger number in a reply carries its question or a short
  description, for example "N53 — confirm the data retention terms". Never write a range of
  ledger numbers.
- The interim notice wording from Unit 4.

The Codex persona is built from the Claude text by markers; the persona tests pin both.

### Unit 6 — the web data hook

- `api/client.ts` gets `getLedgerCard(sessionId)`; `api/types.ts` gets the card types.
- A small store keeps one card per project: it loads when the Control Plane screen shows a
  project, loads again on a `ledger:changed` event for that project (routed in the `App.tsx`
  events handler), and loads again in `resyncAfterReconnect`.
- It keeps the last good card while a reload runs, and an error state when a load fails.

### Unit 7 — the card (web)

Desktop: a `LedgerCard` component at the top of `DispatchWorkPane`, above
`OngoingWorkOverview`. Mobile: the same component at the top of the Work tab in
`OverseerMobile`, with the open decision count on the tab.

- Header: "Needs you", the counts and the time of the last update. A folded line such as
  "Project rules: 10 in force" opens a read-only list.
- Needs you now: full cards for `needsYou.cards`; one line per item in `needsYou.lines`
  (number, question, recommendation). A click on a line opens it as a full card.
- A full card: the number and kind, a NEW badge, the age, "imported" when it applies; the
  question; the context, cut after about three lines with "more"; the options as stacked rows
  (label, then the effect), the recommended row marked; why; what happens without an answer;
  what it holds up; the source (`plan · path › section · plan ID`); the overseer's note.
- A go card has one "Approve" row. Each item under Your tests and actions has a "Done" link.
- Your tests and actions, Running on defaults, Decided since the last recap, Not yet triaged
  and Parked fold to a count. The fold state is kept in local storage.
- When the right pane is collapsed, the right `PanelToggle` shows the open decision count.
- Empty ledger: "Nothing needs you." Load error: "Could not load the decisions" and Retry.

### Unit 8 — clicks fill the message box (web)

The overseer store gets an action that appends text to the project's composer draft:

- a decide option adds `N17: A` (the option's `answerKey`);
- the Approve row of a go item adds `N34: approve`;
- the Done link of an action adds `N55: done`.

With text already in the draft, the action adds `, ` and the new text; it never replaces the
draft. It focuses the composer and shows a hint under it: "Added N17: A. Press Enter to send,
or keep adding." On mobile it also switches to the Stream tab. Nothing is sent without the
user.

### Unit 9 — ledger chips in the chat (web)

A pure function finds ledger numbers (`N` and digits, as a whole word) in Control Plane text,
outside code spans and code blocks, and turns each number that is in the project's `index`
into a chip: the number and the question, cut at about 70 characters, with the full question
as the tooltip. Numbers that are not in the index stay plain text. The question text is
escaped; the chips are made after the markdown is sanitized.

It applies to overseer replies, the user's own messages, the agency notice pills and the
`report_status` cards on the Control Plane screen. A click on a chip opens the right pane,
scrolls to the item and opens it as a full card. An item that is not on the card (answered
long ago) opens a small popover with its question, status and answer.

## Errors and edge cases

- The daemon restarts: the card keeps its last content, shows the load error, and loads again
  when the events socket reconnects.
- A missed event: the next event, a reconnect or a project switch loads the card again.
- Two browser tabs: each loads the card; both stay in step through the event.
- The composer is not mounted (another tab is active): the action keeps the draft in the
  store, and the composer shows it when it mounts.
- Ledger numbers belong to one project. A chip never uses another project's ledger.

## Tests

- Core, Unit 1: `renderLedgerSections` output is unchanged (existing tests), and
  `ledgerSections` matches it section by section.
- Core, Unit 2: the route shape; `answerKey`; no write (`lastRecapAt` and the interim timer
  unchanged after a call); 404; empty ledger.
- Core, Unit 3: each write path calls `onChange` once with its session; a throwing callback
  does not fail the write.
- Core, Unit 4: due timer with a new open item sends the notice; without one it clears the
  timer and sends nothing; delivery retry unchanged.
- Core, Unit 5: the paste block and the own-use block; `ledger_add`'s one line; persona pins
  for the recap format, the one-line rule and the ledger-number rule, Claude and Codex.
- Web: the card draws each section from a fixture; folding and the stored fold state; the
  count on the collapsed pane button; option, Approve and Done clicks append to the draft
  without loss; chips for known numbers only and never inside code; a chip click opens the
  item; reload on `ledger:changed` and on reconnect; the mobile Work tab placement.
- Fixtures copy the shape of real ledger rows with generic text (the repository is public).
- Run against an isolated daemon (fake HOME): the route, the event on a write, the interim
  rule.

## Known limits

- The persona rules (no paste, no bare number) depend on the model. The card and the chips
  do not: the web app adds the question to every known number on the Control Plane screen.
- Text outside the Control Plane screen (thread list summaries, notifications) gets no chips;
  only the persona rule covers it.
- "New" still means "sent after the last recap". Reading the card does not change it.
- The route has no access check of its own; the network is the gate, as for conversations.

## Out of scope (later phase 2 work)

- The cross-project "Needs you" view (with the Board's owner).
- Alerts for new decisions.
- A rules editor (this spec has a read-only list).
- Source links that open a plan at its section.
- Folded overseer replies.
- Buttons that send an answer at once.
- A short title field on ledger items.
- Two small fixes found on 2026-10-08: `queue_agent` should refuse a dependency ID that is no
  thread; the daemon should delete `thread-<id>.mcp.json` when a thread is deleted.

## Build and review

Build from this spec, the default for this repository: one build agent in a worktree, tests
first, one commit per unit in the order above, and a short build record at
`docs/superpowers/plans/2026-10-08-overseer-pinned-card-build-record.md` (decisions the spec
does not cover, deviations, test results). Then two code reviews (Fable and GPT, at most two
rounds), a run against an isolated daemon with real-shaped data, and a PR. The merge, the
release and the deploy each need the user's own yes.
