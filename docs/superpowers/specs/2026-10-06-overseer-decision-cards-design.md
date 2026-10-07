# Overseer decision cards — design (follows the structured recap, PR #62)

Date: 2026-10-06. Approved by the user on 2026-10-06 ("spec looks good to me").
Thread "Opus 5.5 Xhigh Handle Business". This spec extends
`docs/superpowers/specs/2026-10-05-overseer-structured-recap-design.md` and is built
on top of its branch.

## Goal

Every decision that reaches the user arrives as a complete card: the question, the
context, the options with their effects, a recommendation with its reason, what
happens without an answer, and the source it came from. The daemon stores and
renders the card, so the card cannot shrink to a bare plan ID as turns go by.
Decisions from planning and research agents become cards in the agent's own words.
The overseer still filters which decisions reach the user, and every decision that
it makes itself stays visible.

## Decisions so far

All by the user, 2026-10-06.

1. **Separate work, released with #62.** A second PR stacked on #62. Merge #62
   first, then this PR; one release, one deploy, one import ("i like this
   approach").
2. **Card layout: a full card with an option table** (Layout A, "i prefer A"). The
   user works from a desktop for over 95% of the time, so the layout targets a
   desktop-width view.
3. **Full cards per recap: new decisions plus the top 5** ("B"). Every other open
   decision gets one line that holds its question and the recommendation.
   `show N17` or `show all` prints more full cards.
4. **Capture from agents: the overseer picks, the daemon copies** ("B. we need to
   find a balance because the agent often has a less complete picture than the
   overseer. it can make low level calls without surfacing to me"). The agent's
   text is copied word for word; the overseer can add a separate, labeled note; the
   overseer may decide low-level entries itself, and each one shows in the recap.
5. **What the overseer may decide itself: a tiered rule, with levers to tune it**
   ("A is the right one but we may need levers to tune it").
6. **Triage happens when the report arrives; the user sees the result in the
   recap.** The user first read this rule as "present each turn"; after the
   clarification ("oh that is triage not present. I misread it.") the rule stays:
   triage is ledger work in the same turn, not a message to the user.

## Evidence

From four overseer transcripts of one heavy user, 2026-09-01 onward. Project names
and business details are left out on purpose. Overseers A to D.

| | A | B | C | D |
|---|---|---|---|---|
| Decision mentions that are an ID only | 11% | 38% | 17% | 34%* |
| Later mentions that are an ID only | 4% | 48% | 33% | 30% |

\* D counts sample-group labels as decision IDs, so its number is too high.

- **Put off, then shortened.** Overseer B promised "one short list later" for a
  readiness plan, then wrote "LR-1 to LR-26". Of 33 LR decisions, 16 never
  appeared by name in any reply. The path to the 1,780-line plan (on a branch that
  was never pushed) came 4 days after the first mention, and only when the user
  asked.
- **Each summary copies the last one.** The overseer told a board agent to "keep
  each to one line". The memory note, the compaction summary and two later recaps
  then repeated "LR-1 to LR-26, D1 to D9, Q1 to Q6" word for word.
- **A pointer replaces the content.** "My recommendations are in the plan."
- **Work runs on defaults, but the decision stays "open".** D1 to D9 of a guard
  plan ran on the plan's defaults and were deployed in a test mode, while the
  recaps still listed them as waiting for the user.
- **IDs are reused.** In one week, "D1" meant three different decisions.
- **The user's words**, among 17 such messages: "what is my 'managed-only'
  filter?", "what are the 3 decisions?", "restate the questions with full
  context", "give me the full context on this. im not follwoing".
- **What worked:** when the overseer gave one line, a recommendation and the effect
  per decision, the user answered all of them within 7 minutes.

PR #62 already removes two causes: every decision gets its own ledger ID that
never repeats, and the daemon renders the stored text. It does not store context,
a source, option effects or a default, and it has no path from an agent's report
into the ledger.

## Design

### Unit 1 — Card fields (migration 006)

New columns on `ledger_items`, in `migrate(db, '006-ledger-decision-cards', …)`.
Migration 005 from #62 does not change.

| Field | Column | Required |
|---|---|---|
| Context | `context` | `decide` and `go`. 20 to 800 characters. |
| Options with effects | `options` (JSON) | `decide`: at least 2, each `{ label, effect }`. `go`: optional. |
| Recommendation and reason | `recommendation`, `recommendation_why` | When options exist. The recommendation must equal one option label. |
| If you do not answer | `default_text` | `decide` and `go`. "Nothing happens" is a valid value. |
| Source | `source_kind`, `source_ref`, `source_section`, `source_id` | `decide` and `go`. See Unit 2. |
| Overseer's note | `overseer_note` | No. |
| Running on the default since | `on_default_since` | No. Set by `ledger_mark_default`. |
| Agent link | `agent_terminal_id`, `agent_decision_id` | Set when the item came from an agent block. |
| Overseer's choice and reason | `decided_choice`, `reason` | Set when the overseer decides the item itself. |
| Project rule | `policy` (0 or 1) | Only on `statement` items. |

`source_kind` values: `plan`, `doc`, `agent`, `pr`, `issue`, `user`, `overseer`.
`source_id` is the source's own ID, such as `LR-6`. It is a cross-reference only and
never stands alone.

New statuses: `proposed` (from an agent block, not yet triaged) and
`decided_by_overseer`. The `options` column of #62 rows holds plain strings; the
reader accepts both shapes.

### Unit 2 — Checks in the daemon

`ledger_add`, `ledger_import` and the agent-block path apply the same checks. A
failed check returns 422 with a fixed text and changes nothing.

1. **Required fields** for `decide` and `go` (Unit 1). Text:
   `A decision card needs: <missing fields>. Add them and try again.`
2. **One decision per card.** The question must not hold a range of plan IDs, such
   as `LR-1..LR-26`, `D1 to D9`, `D1 TO D9`, `D2-D6`, `Q1–Q6`, `PLAN-1 to PLAN-9`
   or `D1000 to D1009`, and must not name 3 or more plan-style IDs that share the
   same letter prefix (such as `D1, D3 and D4`). Text:
   `One decision per card. Add each decision on its own.`
   - "From X to Y" is a change, not a range: `Move backups from S3 to R2?` and
     `Move the overseer from GPT-4 to GPT-5?` pass.
   - IDs with different prefixes pass: `S3, EC2 and R2`.
   - A pattern cannot separate every product name from a plan ID. The persona rule
     "one decision per card" covers the cases that the check misses. (Changed after
     code review.)
3. **Real sources.**
   - `plan` and `doc`: `source_ref` is a relative path that exists inside the
     project's working directory, including its git worktrees, and does not escape
     it. An absolute path is refused.
   - `agent`: an agent thread of this project, by label or ID.
   - `pr` and `issue`: the form `#123`. The daemon does not call GitHub.
   - `user`: needs a checked quote, as in #62.
   - `overseer`: always allowed.

   Text: `The source does not exist in this project: <ref>.`
4. **Go items stay with the user.** `ledger_decide_self` on a `go` item fails. So
   does `ledger_decide_self` on an item with `source_kind: 'user'`, or on an item
   that was already sent to the user. Text:
   `Only the user can decide this item.`
5. **Project rules need the user's words.** `policy: true` needs a checked quote
   (the rules of #62, including the leading-ok and word-edge rules).

### Unit 3 — Capture from agents

Planner, researcher, reviewer, design-reviewer and code-reviewer personas get one
more instruction: when the report has decisions for the owner, end it with this
block. No block when there are none.

````text
```owner-decisions
[
  {
    "id": "LR-6",
    "kind": "decide",
    "question": "How many clean nights before live mode?",
    "context": "The new sync runs in shadow mode. It computes changes but does not write them. Live mode lets it write. This sets how much clean history we need first.",
    "options": [
      { "label": "A. 5 nights", "effect": "Live mode on Oct 14 at the earliest. Covers one weekend." },
      { "label": "B. 10 nights", "effect": "Oct 19. Covers two weekends." }
    ],
    "recommendation": "A. 5 nights",
    "why": "The weekend pattern is the known risk; 5 nights cover one weekend.",
    "default": "Nothing switches; the shadow run continues.",
    "where": { "path": "docs/plans/readiness.md", "section": "Owner decisions" }
  }
]
```
````

- **When:** at the end of the agent's turn, the daemon reads the agent's final
  message (the full text, not the 600-character summary that notices use).
  - The same read works for Claude and Codex agents. A Codex agent streams its
    text in pieces, so the daemon uses the complete message text of the turn.
  - Text from the agent's own sub-agents is not part of its report.
- **Only a top-level block counts.** A block inside another code block, or indented
  as code, is an example, not a block. The last top-level block wins.
- **Size limits.** A block over 64 KB, or with more than 50 entries, is a broken
  block (the notice line below names the reason). No items change.
- **Agent entries cannot set** `blocks`, `author`, `status`, `policy`,
  `supersedes` or the sent time. The overseer sets "Holds up" at triage.
  (The four points above were added after code review.)
- **Each valid entry becomes a `proposed` item** with its own N-ID. The source is
  `agent` (the agent's label), with `where.path` as the section reference and `id`
  as `source_id`.
- **Each invalid entry is reported** by its `id` and the failed check. It does not
  become an item.
- **Repeats:** if the same agent emits the same `id` again with the same question,
  nothing changes. With a changed question, the new item supersedes the old one
  while the old one is still `proposed`.
- **The Finished notice gains a line:**
  `This report has 7 owner decisions (N30 to N36). Triage each now: ledger_add_from_agent sends it to the user; ledger_decide_self records your own choice.`
  A broken block gives:
  `The owner-decisions block could not be read: <reason>. Ask the agent to fix it.`

### Unit 4 — Tools

New:
- `ledger_add_from_agent({ id, note?, blocks? })` — sends a `proposed` item to the
  user (status `open`). The agent's text stays word for word; `note` becomes the
  "Overseer's note", and `blocks` the "Holds up" field.
- `ledger_decide_self({ id, choice, reason })` — a low-level call by the overseer
  on a proposed item (status `decided_by_overseer`). Unit 2, rule 4 limits it.
- `ledger_decide_self({ choice, reason, …card fields })`, without `id` — records a
  low-level call that did not come from an agent block, such as an answer to an
  agent's live question. It creates a `decide` item that is already decided and
  was never sent to the user. The card checks apply, and a `user` source is
  refused. (Added after code review: without it, the overseer could not record its
  own decisions.)
- `ledger_mark_default({ id })` — work now runs on the default of an open item.
  The item stays open and moves to "Running on defaults".
- `ledger_show({ ids? , all? })` — full cards, rendered by the daemon.

Changed:
- `ledger_add` takes the card fields of Unit 1.
- `ledger_note` takes `policy: true`.
- `ledger_resolve` may set `answered` on a `decided_by_overseer` item, with the
  user's checked quote. That is a reversal, and the counts in Unit 5 include it.

The dispatch MCP grows from 22 to 26 tools.

### Unit 5 — The recap and the card

`ledger_list({ forRecap: true })` renders, in this order:

1. **Project rules (your words)** — only when rules exist.
2. **Needs you now** — full cards for every decision that is new since the last
   recap, plus the top 5: first the items that hold up work, then the oldest. Every
   other open decision gets one line.
   - "New" means sent to the user after the last recap: created as `open`, or
     moved from `proposed` to `open`.
   - "Holds up work" means the `blocks` field is set.
   - "Oldest" means the earliest time the item was sent to the user.
3. **Running on defaults** — one line each, with the start date.
4. **Your tests and actions** — as in #62.
5. **Decided since the last recap** — the user's answers (as in #62) and one line
   for each decision that the overseer made itself.
6. **Not yet triaged** — `4 proposed decisions from "Readiness planner" (N30, N31, N32, N33).`
7. **Parked** — as in #62.
8. A count line: `Overseer decisions in the last 7 days: 6. Reversed by you: 1.`

**The full card.** Each field is its own paragraph (a blank line between fields),
so markdown never joins two fields:

```text
**N14 · Decide:** How many clean nights before live mode?

Holds up: the switch to live mode · Open 2 days · Source: plan `docs/plans/readiness.md`, section "Owner decisions" (`LR-6`), from agent "Readiness planner"

**Context:** The new sync runs in shadow mode. …

| Option | Effect |
|---|---|
| **A. 5 nights (recommended)** | Live mode on Oct 14 at the earliest. Covers one weekend. |
| B. 10 nights | Oct 19. Covers two weekends. |

**Why A. 5 nights:** The weekend pattern is the known risk; …

**If you do not answer:** Nothing switches; the shadow run continues.

**Overseer's note:** …

**Answer with:** `N14: A`, or your own words.
```

A `go` card uses `· Go:` in the title, shows the table only when it has options,
and ends with ``**Answer with:** `N12: merge` `` (the named-approval rule of #62).

**The one-line forms:**

```text
- **N17 · Decide:** Keep or drop the old tag check? Recommended: drop. Holds up: nothing. (`LR-12`, type `show N17`)
- **N9 · Decide:** Abort when duplicates pass 1%? Running on the default "abort above 1%" since Oct 1. Recommended: keep. (type `show N9`)
- **N21 · Decided by overseer:** Which retry helper? → the existing one. Reason: it already covers this case. (Reply "reverse N21" to change it.)
```

Added after code review:
- A reversal reads `You reversed the overseer's choice "<choice>": "<quote>" (<time>)`,
  not "You approved".
- An imported item keeps its "Imported, not checked" label in every form,
  including the "Running on defaults" line.

### Unit 6 — The Batch line

The Batch line of #62 gains one sentence when proposed items exist:
`Not yet triaged: N30, N31.`

### Unit 7 — Persona changes

Overseer:
- **The tiers.**
  - Always the user's: merge, deploy and release items; anything that reverses or
    widens a decision the user recorded; changes to production data; cost or
    spend; messages to people outside the team; adding or dropping scope.
  - The overseer may decide, and records it with `ledger_decide_self`:
    implementation details inside an approved plan; a choice between technical
    options of equal effect; names, test approach and order of work; questions that
    only affect the agents.
  - When unsure: the user's.
  - Project rules in `ledger_list` override the default tiers.
- **Triage proposed decisions in the turn the report arrives.** This is ledger
  work, not a message to the user: the Batch line still limits the reply. The user
  sees the result in the next recap.
- **Never name a decision by a plan ID or a range. Never write "it is in the
  plan".** Use the N-ID with its question.
- **Post cards exactly as the daemon renders them.**
- **User commands.** "show N17" or "show all" → `ledger_show`. "reverse N21" →
  `ledger_resolve` with the user's quote. A rule from the user → `ledger_note` with
  `policy: true`.
- **Own decisions.** When the overseer adds a `decide` or `go` item itself, it fills
  every required field.

Agents: the `owner-decisions` block instruction of Unit 3.

## Data flow (one plan)

1. A planner finishes. Its report ends with an `owner-decisions` block of 7
   entries. The daemon creates N30 to N36 as `proposed` and adds the count line to
   the Finished notice.
2. In the same turn, the overseer triages: it sends N30, N31 and N34 to the user,
   one of them with an overseer's note, and decides N32, N33, N35 and N36 itself,
   with reasons. Its reply is one line.
3. The batch settles. The recap shows full cards for N30, N31 and N34, and four
   "Decided by overseer" lines.
4. The user answers `N30: A` and `reverse N33, use the other helper`. The overseer
   records both with `ledger_resolve`. The next count line shows one reversal.

## Errors

| Case | Result |
|---|---|
| A required field is missing | 422 `A decision card needs: …` |
| A range or 3+ plan IDs in a question | 422 `One decision per card. …` |
| The source does not exist | 422 `The source does not exist in this project: …` |
| `ledger_decide_self` on a protected item | 422 `Only the user can decide this item.` |
| A broken agent block | The notice line from Unit 3; no items change. |
| One invalid entry in a valid block | Only that entry is skipped; the notice names it. |

## Known limits

- The daemon checks that the fields exist, not that the context is true or
  enough.
- The agent may know less than the overseer. The overseer's note covers part of
  that gap.
- The overseer decides what counts as low-level. The tiers, the project rules and
  the count line keep this visible and tunable; the daemon only hard-blocks `go`
  items, user-sourced items and items already sent to the user.
- The source check confirms a file or an agent, not the section inside a file.

## Tests

- **Migration 006** on an existing database; old #62 rows still render.
- **Checks:** each missing field; ranges and 3+ IDs (and a single `LR-6` passes);
  each source kind, including a path that escapes the project; the protected items
  for `ledger_decide_self`; a project rule without a checked quote.
- **Agent block:** a valid block, an invalid entry, a broken block, no block, a
  repeat with the same and with a changed question; the full final message is
  read, not the notice summary.
- **Triage tools:** verbatim copy plus a note; a decision by the overseer; a
  reversal with a quote; `ledger_mark_default`; `ledger_show` for one, several and
  all.
- **Rendering:** the full card (a blank line between fields, the option table, the
  recommended option marked); the go card; the one-line forms; the section order;
  new plus top 5; the count line; the Batch line sentence.
- **Persona:** the tiers, the triage rule, the naming rules, and the agent block
  instruction for all five agent types; the six Codex marker strings stay.
- **End to end with the fake CLI:** a planner turn with a block creates proposed
  items, and the notice names them.

## Rollout

1. This PR stacks on #62. Merge #62 first, retarget this PR to `main`, then merge.
   Each merge needs the user's own approval.
2. One release, one deploy (a daemon restart), each with its own approval.
3. Each overseer runs `ledger_import` once. Imported decisions need the card
   fields. For a large plan, the overseer has a planner agent turn the plan's
   decision list into an `owner-decisions` block; the daemon makes the cards; the
   overseer triages them once. This replaces the bare-ID lists of today.
4. After one week, rerun the decay measurement. Targets: no decision mention that
   is an ID only, and no "what is X" questions from the user about a decision.

## Phase 2 (not in scope)

- A view to edit project rules.
- Source links that open the file at the section in the Dispatch viewer.
- The pinned recap card and the cross-project "Needs you" view from the #62 spec.
