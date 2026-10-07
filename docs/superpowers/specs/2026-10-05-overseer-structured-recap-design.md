# Overseer structured recap and decision ledger — design (phase 1)

Date: 2026-10-05. Approved by the user on 2026-10-05 ("spec looks good"), with one
addition: decision 4. Thread "Opus 5.5 Xhigh Handle Business".

## Goal

Every overseer (Control Plane coordinator, Claude or Codex) reports to the user in
one structured recap per settled batch of agent work, not in one reply per agent
turn. Every decision, approval and statement that the overseer attributes to the
user carries the user's exact words, and the daemon checks those words against the
messages that the user really sent.

## Decisions so far

1. **Scope: B plus ledger** (user, 2026-10-05). Phase 1 = settle facts in agent
   notices, a new persona contract, and a decision ledger with checked quotes.
   Phase 2 (separate spec) = a pinned recap card, one "Needs you" view across
   projects, and folded intermediate replies.
2. **Settled = all agents of the overseer are idle, with a 20-minute limit**
   (user, 2026-10-05, "A but … maybe 20"). The value comes from the data below.
3. **Statements: the user's exact words, plus a reading** (user, 2026-10-05,
   "1. A"). The overseer records the user's own statements with the exact words.
   When it applies them more widely, it adds a separate "I read this as: …" line.
   Rejected: only statements marked "rule:" or "decision:" (unmarked statements get
   lost), and exact words only with a new question for each wider use (too many
   questions).
4. **"ok" at the start of a message is never an answer** (user, 2026-10-05: "ok
   does not mean any kind of agreement or approval for the last response. it does
   not authorize and merge or deploy EVER"). The user often starts a message with
   "ok" when they come back to a session. That word does not agree with, answer or
   approve anything, and it never authorizes a merge, a push to a protected branch,
   a release or a deploy. Only the words after it can answer an item. The daemon
   enforces the mechanical part (Unit 2, rule 6), and the persona carries the
   rest (Unit 6).
5. **A `go` item needs a named approval** (proposed in this thread; user,
   2026-10-05: "yes, include #12"). A `go` item (merge, deploy, release) becomes
   `answered` only when the quote contains the item ID or an action word. A bare
   "yes" does not approve a `go` item. The daemon enforces it (Unit 2, rule 7).

Defaults that the user did not object to: one ledger per project, IDs `N1`, `N2`, …
that never repeat; a new decision goes to the user at once in a short message;
agent questions and blocks still reach the overseer at once; the change applies to
the Claude and the Codex overseers.

## Evidence

From the coordinator transcripts and the Dispatch database of one heavy user
(2026-10-05). Project names and business details are left out on purpose.

- **Overseer A, before a prompt-only recap rule (4 days):** 49 agent notices, 48
  long reports, about 1,900 characters each, no recaps.
- **Overseer A, the same day after the rule:** 6 notices, 5 short notes, 1 recap
  when all agents stopped. The rule worked in the same context.
- **Overseer A, three days later:** 15 notices, 8 long reports without the recap
  form, 4 recaps for one PR only, 3 short notes. The rule drifted.
- **Overseer B:** the user asked for a recap about 5 times in one week. Two
  compactions dropped the open-decision list.
- **Provenance drift, overseer B:** the overseer asked question (c): should one
  specific set of products be set to Draft? The user answered "c. yes". Four
  minutes later, an agent task described "the owner's rule (c)" with a wider set
  of products, in the overseer's own words. At least 7 more agent tasks, the
  project's status board, and the next compaction summary carried "rule (c)".
  Overseer A's memory records two earlier cases of the same kind.
- **Batch timing** (`usage_turns`, 4 busy overseers, 667 agent turns since Sep 1,
  turns less than 5 minutes apart count as one batch): the time from the first
  finished turn to the moment no agent works is median 3.4 min, 75th percentile
  12.7, 90th 34.4, maximum 137. 18% of batches pass 20 minutes; 4% pass 60.
- **User cadence** (`message_source`, gaps under 3 hours): median 7.2 min between
  messages to one overseer, 75th percentile 21.6, 90th 59.

## Root causes (code)

1. `noteAgentCompletion` (`sessions/service.ts` ~1275) sends every finished agent
   turn to the overseer at once. Each notice starts an overseer turn, and each turn
   writes a reply. The notice text says "or report back to the user".
2. The persona's WATCH paragraph (`overseer/prompts.ts` ~76) says "synthesize and
   report to the user". A memory rule fights the system prompt on every notice.
3. No notice says which agents still work, so "settled" is a guess.
4. Open decisions exist only in the model context. A compaction can drop them.
5. Nothing stores the user's own words. `message_source` stores a tag only, only
   for Claude, and a queued send can move the tag to the wrong message.
6. Overseers end turns without `report_status` (`lastOutcome.inferred = 1` on both
   overseers), so the board cannot show "Overseer needs you".

## Design

### Unit 1 — Message log (`coordinator_messages`, new table)

Purpose: a record of every message that reaches an overseer, with the sender.

- **Columns:** `id` (integer key), `terminal_id`, `sent_at` (ISO), `source`, `text`.
  - `source` values:
    - `user`: the human typed it.
    - `canned`: a card click sent fixed text.
    - `coordinator`: another thread sent it through MCP.
    - `daemon`: a notice, a watch or a kickstart.
  - `text` holds the text blocks joined. An image becomes `[image]`.
- **Write point:** `SessionService.sendStructuredMessage`, after
  `manager.sendMessage` returns, only for a terminal with `config.role ===
  'coordinator'`. All structured sends for both harnesses pass through this
  function.
  - A send with no `source` is `daemon`.
  - A write failure is logged and does not block the send.
  - The user's answer to the overseer's own question card (`AskUserQuestion`) is
    also logged as `user`: one row per answered question, with the answer only.
    The overseer writes the header and the question, so they are never logged as
    the user's words. Each answer is its own message, so an "ok" answer is a
    leading "ok". It does not pass through `sendStructuredMessage`, so the answer
    path logs it. Answers to ordinary tool permissions are not logged. (Added after
    code review.)
- **Web change:** the canned "need" acknowledgement (`overseer/store.ts` ~342)
  sends a `canned` marker. The route stores it as `canned`, not `user`.
- **Migration:** `migrate(db, '005-coordinator-messages-and-ledger', …)` in
  `db/schema.ts`. Do not use the legacy column list; it reaches only new databases.
- **No backfill and no pruning in phase 1.** About 500 rows a month across all
  overseers.

### Unit 2 — Decision ledger (`ledger_items`, new table)

Purpose: the durable list of everything that needs the user, and of everything the
user decided or said, with the user's exact words.

| Column | Meaning |
|---|---|
| `id`, `session_id`, `seq` | `seq` counts up per project; the user sees `N<seq>`. |
| `kind` | `go` (merge, deploy, release approval), `decide` (a choice), `do` (a manual step for the user), `statement` (the user's own words). |
| `text` | The item as shown to the user. **Never changes after creation.** |
| `author` | `overseer`, an agent label, or `you` (for `statement`). |
| `recommendation`, `options`, `blocks`, `mission` | Optional. `blocks` = what the item holds up. |
| `status` | `open`, `answered`, `parked`, `withdrawn`, `superseded`. |
| `quote`, `quote_message_id`, `quote_at` | The user's exact words and the message that holds them. |
| `reading` | Optional "I read this as: …" text from the overseer. |
| `reason` | Required for `withdrawn`. |
| `supersedes` | The `seq` of an older item that this item replaces or widens. |
| `origin` | `live` or `imported`. |
| `created_at`, `updated_at` | |

Rules that the daemon enforces:

1. **Only the project's overseer can change the ledger.** The route checks that the
   calling terminal has `config.role === 'coordinator'` in the same session. This
   is the same trust level as other agency routes.
2. **A claim about the user needs a checked quote.** To set `answered` or
   `parked`, or to create a `statement`, the quote must match part of one `user`
   message in this overseer's log.
   - The match ignores case and runs of white space.
   - The match must start and end at word edges in the message: no letter or digit
     directly before or after it, whatever the quote's own first and last
     characters are. A surrogate pair counts as one character. So `N1` does not
     match inside `N12`, `merge` does not match inside `merged`, and `N12:` does
     not match inside `N12:yes`. A quote with no letter or digit fails. (Added
     after code review.)
   - For `answered` and `parked`, the message must come after the item's
     `created_at`.
   - A `canned`, `coordinator` or `daemon` message never matches. Agent notices,
     and user messages that a notice relays from an agent thread, are `daemon`.
   - If several messages match, the daemon picks the earliest one after
     `created_at`.
3. **Item text never changes.** A wider scope, such as "also the second store?", is a new item
   with `supersedes`. The recap shows the original question next to it.
4. **The overseer can close its own item without a quote only as `withdrawn`,**
   with a reason. The next recap shows it once: "Withdrawn by overseer: …".
5. **`imported` items are shown as "Imported, not checked".** They become checked
   when the user confirms them and the overseer records that quote. A `withdrawn`
   or `superseded` item is always closed, imported or not. A withdrawn imported
   item shows the withdrawal and its reason. (Added after code review.)
6. **A leading "ok" never counts** (decision 4).
   - The daemon finds a leading ok-word at the start of the message: `ok`,
     `okay`, `k` or `kk`, in any case, with any punctuation and spaces after it.
     A match that starts inside that span starts after it. So the quote `k` from
     the message `ok` fails.
   - If nothing remains, the check fails with: "An 'ok' at the start of a message
     is not an answer. Ask the user."
   - The stored quote is the words that remain.
   - The same rule applies to every status that needs a quote, and to `statement`
     items.
7. **A `go` item needs a named approval** (decision 5). To set a `go` item to
   `answered`, the quote (after rule 6) must contain the item ID, such as `N12`,
   or one of these action words: `merge`, `deploy`, `release`, `push`, `restart`,
   `update`. The match ignores case and must be a whole word. If it fails, the
   check fails with: "A go item needs its ID or the action word in the user's
   answer. A bare yes is not enough. Ask the user." `parked` on a `go` item does
   not need this.

Labels in every rendered line:

- `You said: "<quote>" (Mon 16:51)` — a `statement`.
- `You approved: "<text>" → "<quote>" (Mon 16:51)` — `answered` on `go`/`decide`.
- `Proposed by <author>, not approved` — `open`.
- `I read this as: …` — a separate line, only when `reading` is set.

### Unit 3 — Ledger tools (dispatch MCP)

Five new tools. The routes reject callers that are not the overseer, so any other
thread gets a clear error.

- `ledger_add({ kind, text, recommendation?, options?, blocks?, mission?, author?, supersedes? })`
  creates an `open` item. It returns the ID and the rendered line. The persona
  tells the overseer to post that line as is.
- `ledger_resolve({ id, status, quote?, reading?, reason? })`
  - Sets `answered`, `parked` or `withdrawn`.
  - `answered` and `parked` need `quote`; `withdrawn` needs `reason`.
  - If the quote check fails, the result says: "Quote not found in the user's
    messages to you after N12 was created. Do not record it. Ask the user."
- `ledger_note({ quote, reading?, mission? })` creates a `statement` from a checked
  quote.
- `ledger_list({ forRecap? })` returns the rendered ledger part of a recap:
  - **Needs you now:** open `go` and `decide` items.
  - **Your tests and actions:** open `do` items.
  - **Decided since the last recap.**
  - **Parked.**

  `forRecap: true` also stamps the overseer's `lastRecapAt` and clears the
  interim timer (Unit 5).
- `ledger_import({ items })` loads open items and earlier decisions from the
  overseer's current context with `origin: 'imported'`. It is used once per
  overseer at rollout.

Hand-offs: `spawn_agent`, `queue_agent` and `message_agent` gain `ledgerIds?`. The
daemon appends a block "Owner decisions (verbatim, from the ledger)" with the
rendered lines, so agents get the question and the user's words, not a paraphrase.

### Unit 4 — Settle facts in every agent notice

The daemon sends these notices to the overseer today, plus one new type. The
prefix is the first character of the notice text. The web display uses the prefix
and a phrase to find the notice type.

| Notice | Prefix | Sent by | When |
|---|---|---|---|
| Finished | `✅` | `noteAgentCompletion` | An agent finished a turn. |
| Blocked | `⏸️` | `noteAgentNeedsHelp` | An agent stopped its turn to ask. |
| Question | `🔔` | `formatAgentQuestion` | An agent is paused on a question. |
| Stopped | `⚠️` | `noteAgentLifecycle` | The user stopped or interrupted an agent. |
| Direct message | `💬` | `noteUserMessageToAgent` | The user sent an agent a message directly. |
| Interim recap (new) | `🕒` | Unit 5 sweep | 20 minutes passed and agents still work. |

The rest of this spec uses the names in the first column.

A new helper, `batchState(sessionId, { exclude, justStarted })`, looks at the
overseer's agents (`config.role === 'agent'`, same session, not archived, no
`roleRun`). It sorts them into three groups:

- **Working:** `working` without a question pending to the overseer, `scheduled`,
  and the dependents that `startQueuedDependents` just promoted. Those still read
  `waiting` at that moment, so the helper must return their IDs.
- **Queued:** `queued`.
- **Waiting on the overseer:** `needs_input`, or `working` with a pending question
  (`manager.getPending`).

The Finished, Blocked, Question, Stopped and Direct message notices get a last
line, the Batch line.

When agents still work:

```text
Batch: still working — 2 agents ("Build X", "Review Y"); 1 queued.
Do not post a recap. If this needs a decision, add it with ledger_add
and post only that item. Otherwise write at most one line.
Open ledger items: N3, N7.
```

When nothing works:

```text
Batch: no other agent is working or queued.
If you start a next step now, write at most one line.
If you start nothing, the batch has settled: post the recap now
(ledger_list with forRecap, and list_agents).
Open ledger items: N3, N7.
```

The open-item list in every notice brings the ledger back into context after a
compaction. The daemon cannot detect a compaction today, so the design does not
depend on one.

The Finished notice drops "or report back to the user".

A Direct message notice counts its own agent as working, unless that agent waits
on a question; then it counts as waiting on the overseer. If the batch computation
fails, the notice still goes out, without the Batch line. (Added after code
review.)

### Unit 5 — Interim recap after 20 minutes

- **Start:** when a Finished notice goes out with agents still working and no
  timer is running, the daemon stores `interimDueAt = now + 20 min` on the
  overseer's config.
- **Stop:** a settled notice, or `ledger_list({ forRecap: true })`, clears it.
- **Check:** a 60-second sweep with an injectable `now`, after the auto-archive
  sweep pattern. The due time is in the database, so a daemon restart keeps it.
- **Fire:** if agents still work or are queued at the due time (the same "busy"
  rule as the Batch line), the daemon sends one Interim recap notice:

  ```text
  🕒 Interim recap due: agent turns finished 20 minutes ago, and 2 agents
  still work. Post the recap now and mark it "interim". Then keep holding.
  ```

  When only queued agents remain, the count reads `1 agent is queued` (or
  `2 agents are queued`); when both, `2 agents still work and 1 agent is queued`.
- **Delivery:** the daemon clears the due time only after the notice reaches the
  overseer, or when the batch is no longer busy. A failed delivery stays due, and
  the next sweep tries again. (Both points added after code review.)

- The Interim recap prefix must differ from the Finished, Question and Stopped
  prefixes. If it does not, the web shows it as the wrong notice type.

### Unit 6 — Persona contract (`overseer/prompts.ts`)

Replace the WATCH paragraph and add a REPORTING paragraph. Content:

- Follow the notice's Batch line. Call `read_agent` once when you need the content
  to act.
- **Recap format, in this order, at most about 25 lines:**
  1. A header: `<project> · <time> · <n> decisions, <n> tests, <n> agents working`.
  2. **Needs you now** — paste from `ledger_list`.
  3. **Your tests and actions** — paste from `ledger_list`.
  4. **Running** — from `list_agents`, with what happens when each finishes.
  5. **Done since the last recap** — one line each, with PR numbers and links. No
     evidence sections; give the evidence only when the user asks.
  6. **Parked** — paste from `ledger_list`.
- "recap" from the user means: post this format now.
- **Provenance:**
  - Never write "your rule", "you decided", "you said" or "you approved" except
    when you paste a ledger line that has a quote.
  - A "yes" approves only the item text.
  - A message that starts with "ok" does not agree with, answer or approve
    anything by that word. Read only the words after it, and use them only if
    they answer the item. "ok" never authorizes a merge, a push to a protected
    branch, a release or a deploy.
  - A wider use is a new item, or a `reading`.
  - Pass `ledgerIds` to agents. Do not restate the user's decisions in your own
    words as the owner's rule.
- **Every question to the user goes into the ledger first.**
- **Do not save a proposal as a standing rule in memory before the user approves
  it.** When you save a rule, include the user's quote.
- After 3 days with no answer, ask once to keep or park an item.
- If your context starts with a continuation summary, call `ledger_list` before you
  answer.
- End each turn with `report_status`: `needs_you` when open `go` or `decide` items
  exist; `blocked` while your agents still work and nothing needs the user;
  otherwise `done`. This matches the peer prompt, which teaches `blocked` for
  waiting on another agent. (Changed after code review.)

Constraints:

- The Codex variant is built with `indexOf`/`replace` on exact persona strings.
  Keep every marker string, and add a test that fails when a marker is missing.
- `prompts.coordinator.test.ts` pins the `spawn_agent(...)` signature string.
  Update it for `ledgerIds?`.

### Unit 7 — Web (small)

`overseer/components/Stream.tsx` `detectAgencyNotice`:

- Add a branch for the Blocked notice. Today it shows as a raw "You" bubble.
- Add a branch for the Interim recap notice.
- Add tests for all six notice types, including a notice with the Batch line.

## Data flow (one batch)

1. Agent A finishes. The daemon marks A `waiting`, starts A's dependents, and
   builds the Finished notice with the Batch line: "still working: B". It stores
   `interimDueAt`.
2. The overseer hands A's output to the next step, or writes one line.
3. Agent B asks a question. The Question notice reaches the overseer at once. The overseer
   cannot decide, so it calls `ledger_add`, posts "N8 [Decide] …", and calls
   `report_status(needs_you)`.
4. The user answers "N8: A, but only for the first store". The message log stores
   it as `user`. The overseer calls `ledger_resolve(N8, answered, quote: "A, but
   only for the first store")`. The daemon finds the words and stores the message
   link.
5. B finishes. The Batch line says "no other agent is working or queued". The
   overseer starts nothing, calls `ledger_list({ forRecap: true })` and
   `list_agents`, and posts the recap. The timer clears.

## Errors

| Case | Result |
|---|---|
| Quote not found | Tool error with the fixed text above. The ledger does not change. |
| Caller is not the overseer | 403: "Only the project's overseer can change the ledger." |
| Unknown ID | 404. |
| Item already closed | 409, with the current status. |
| Message-log write fails | Logged; the send continues. A later quote check can then fail, and the overseer asks again. |
| Overseer process is down when a notice or the timer fires | `ensureStructuredAlive`, as notices do today. |

## Known limits

- The daemon checks that the user's words exist. It cannot check that the
  overseer understood them. The `reading` line makes a wide reading visible.
- The route trusts the `source` field in the request body. An agent with shell
  access could send a message tagged `user`. Per the guardrail policy ("drift, not
  an adversary"), phase 1 documents this and does not fix it.
- The overseer pastes the rendered ledger lines. Phase 1 cannot force it to paste
  them unchanged; the phase 2 card removes this step.
- An overseer that still runs keeps its old persona until its process restarts.
  The persona is rebuilt at each spawn and resume, so a daemon restart applies it.
- Interim recap delivery is "at least once" in two rare cases, found in review
  round 2 and accepted:
  - If the database write that clears the due time fails after a delivered
    notice, the next sweep sends the notice again.
  - A Codex overseer receives messages asynchronously, so a late delivery failure
    cannot stop the due time from clearing. That notice is then lost.
- The daemon cannot check what a clicked card option means. A clicked option label
  counts as the user's words, the same as a typed answer.

## Tests

- **Database:**
  - The ledger module: `seq` per project, text immutable, status changes.
  - The message log: written only for overseers, all four `source` values.
- **Quote check:**
  - Case and white space ignored.
  - Only messages after `created_at`.
  - `canned`, `coordinator` and `daemon` messages never match, including a Direct
    message relay.
  - A leading ok-word is removed. "ok", "OK.", "okay, " and "k" alone fail. "ok,
    merge N12" stores "merge N12". An "ok" in the middle of a message is not
    removed.
  - A `go` item: "yes" fails; "yes, merge it" and "N12: yes" pass; "emerged"
    does not count as "merge".
- **Renderer:** labels, ages, the order of the sections, imported items.
- **Batch state:**
  - Just-promoted dependents count as working.
  - An agent with a pending question counts as waiting on the overseer.
  - Role runs are excluded.
  - Busy and settled footers on all five notice types.
- **Interim timer** (injectable `now`):
  - Arms once.
  - Survives a restart (due time in the database).
  - Clears on a settled notice and on `forRecap`.
  - Fires once.
- **Routes and MCP:**
  - The tool list grows from 17 to 22.
  - The overseer-only check.
  - `ledgerIds` appends verbatim lines to `spawn_agent`, `queue_agent` and
    `message_agent`.
- **Persona:**
  - Contract substrings.
  - The Codex marker test.
  - The updated signature pin.
- **Web:** `detectAgencyNotice` cases.
- **End to end** (`tests/routes/structured.test.ts` style, fake CLI):
  - A human send is logged as `user`, and a notice is logged as `daemon`.
  - A quote resolves end to end.

## Rollout and measurement

- Ship in a release. Deploy (a daemon restart) needs its own approval.
- After the deploy, each overseer imports its open items once with
  `ledger_import`. The user then confirms or drops the imported decisions.
- After one week, rerun the transcript measurement used for this spec. Targets:
  - At least 80% of agent notices get a reply of one line or less.
  - About one recap per settled batch, plus interim recaps.
  - Zero "your rule / you decided / you approved" phrases without a ledger quote.
  - Fewer "recap" requests from the user.
- The per-project memory rules that the user already gave two overseers stay.
  They agree with the persona.

## Phase 2 (separate spec, not in scope)

- A pinned recap card that the daemon renders from the ledger.
- One "Needs you" view across projects.
- Intermediate overseer replies folded into one row.
- Alerts tied to new `go` and `decide` items.
