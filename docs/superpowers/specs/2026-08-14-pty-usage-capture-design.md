# PTY usage capture — design

Date: 2026-08-14
Status: design, awaiting approval
Branch: `worktree-analytics-usage`
Builds on: `2026-08-14-pty-usage-coverage-scoping.md`, `2026-08-14-codex-transcript-findings.md`

## 1. The gap

Analytics records one `usage_turns` row per turn, live, from the structured manager's
events. A PTY thread never reaches that manager, so it records nothing.

PTY is not a rounding error. Counted from the user's own database:

| | PTY | Structured |
|---|---|---|
| All time | 233 (52%) | 215 (48%) |
| Active | 101 (46%) | 116 (54%) |

**What is already covered.** The history importer has no transport filter
(`routes/analytics.ts:96-104`): it takes any thread with an `external_id` and a
resolvable transcript. Claude PTY threads have both, so one press of Import history
already backfills them. This design is therefore about **live capture from now on**,
not about history.

## 2. The trigger

Both providers announce the end of a turn. Neither is a timing heuristic.

| Provider | Close signal | Where |
|---|---|---|
| Claude Code | `Stop` hook | `status/events.ts:42` |
| Codex | `agent-turn-complete` notify | `status/events.ts:55` |

Both already flow through `StatusService.ingest`. `pty-timing` describes only how *busy*
is detected; the close half is event-driven for both.

`StatusService` exposes this today only as a single-callback `threadSettledHook`. This
design adds a proper subscriber seam — the PTY analogue of what `wirePermissionMembrane`
does for the structured `idle` event.

## 3. Two providers, two mechanisms

The transcripts differ in a way that makes one shared mechanism wrong.

### Claude Code — byte cursor, sum the messages

A Claude transcript carries **per-message** `usage` blocks and no running total. To get
one turn's usage you must sum the messages that belong to it. So the reader needs to know
where the previous turn stopped: a per-thread byte cursor.

- Locate with the existing `resolveTranscriptPath(workDir, external_id)`.
- Parse with the existing `analytics/frames.ts`. No new parser — the importer proves it
  reads this shape.
- On close: read from the cursor to end of file, sum, write one row, advance the cursor.

### Codex — last-seen total, diff it

A Codex transcript carries a **running total** in every `token_count` event. Diff it.

This is the one place the evidence overturned the obvious approach. `last_token_usage`
looks like a ready-made per-turn delta, but it is not reliable:

- `total_token_usage` is monotonic non-decreasing across **648 transitions**, with 0
  decreases, and it survives three real `/compact` events without resetting.
- `last_token_usage` breaks the delta invariant in **9 of 648 transitions (1.4%)** —
  duplicate emissions, events before `turn_aborted`, and post-compaction events all report
  `diff(total) == 0` alongside a non-zero `last_token_usage`.
- Summing it across one real file **overcounts by 767,661 tokens (0.96%)**.

So Codex stores a **last-seen total per thread**, not a byte offset:

- On close: read the tail of the file, take the newest `token_count`, subtract the
  last-seen total, and that difference is the turn's usage. Store the new total.
- No byte cursor. That makes Codex immune to the relocation and compaction desync risks
  that the Claude cursor must handle, because a total is meaningful regardless of where in
  the file it was found.
- A tail read suffices because only the *newest* `token_count` and the *newest*
  `turn_context` matter. Read a bounded window from the end, and widen it only if neither
  is found.

**Guard:** if the diff is negative, the total reset in a way we have not observed. Do not
write a negative row. Record zero, reset the stored total to the new value, and log it.

## 4. Locating a Codex transcript

The filename's uuid **equals** the `external_id` Dispatch stores — verified 5 of 5 against
real rows. So the locator is a filename glob for `rollout-*-<external_id>.jsonl`.

Two facts shape the implementation:

- **`session_index.jsonl` is unusable.** It exists, but its last write was 2026-06-08 and
  it carries no path field. Do not build on it.
- **The date bucket is local time; `terminals.created_at` is UTC.** A session created late
  in the evening local time lands in what a naive UTC conversion would call the previous
  day's bucket. **Do not compute a single bucket.** Glob across buckets — on this machine
  that is 441 files across 51 directories and costs 0.00s, because a filename glob reads
  metadata only.

Archived sessions (`~/.codex/archived_sessions/`, flat, 4 files) matter only for a
historical import, not for live capture.

## 5. Model attribution

`session_meta.model` is `null`. The model comes from **`turn_context`**, which repeats once
per turn — occasionally twice for one `turn_id` when compaction splits it.

Real strings on this machine are codename-suffixed: `gpt-5.6-sol`, `gpt-5.6-terra`.

A mid-session `/model` switch is real and was observed in an actual file (turns 1-3 on
`terra`, turn 4 onward on `sol`). Attribution is therefore simply per-turn: each turn takes
the model from its own `turn_context`. No session-level model is correct.

## 6. Invariants — the parts that are not optional

**Bootstrap at the end, never at zero.** A cursor or total that starts at zero would, on
the first close after this ships, attribute a thread's entire prior history to one turn —
and duplicate exactly what Import history covers. Both providers bootstrap from the
current end state at first sight, floored at the global `analytics_tracking_started_at`.

**One atomic write.** The row and the cursor-or-total advance together in a single
transaction. Row first then a crash re-reads the same range and double-counts; state first
then a crash silently loses the turn.

**A thread is one or the other.** A terminal is PTY or structured, never both
(`sessions/service.ts:862`), so the two writers can never target the same row. But this
does make a second writer to `usage_turns`, and the design doc's "nothing else adds
tokens to this table" rule must be restated as **one writer per transport**, with the
same reasoning that already covers the recorder and the importer.

**Relocation (Claude only).** A thread that moves (`EnterWorktree`) writes to a new file,
where the old byte offset is meaningless. Detect the resolved path changing and treat the
new file as fresh. Codex is unaffected — a total does not depend on position.

**Compaction (Claude only).** Nobody has verified Claude's transcript is strictly
append-only across `/compact`. If the file is shorter than the cursor, reset rather than
read from a desynced position.

## 7. What stays uncovered

**Grok.** No transcript, no session-id capture, no event of any kind
(`providers/grok.ts:26-45`). Covering it needs an ACP parser and a status integration
first — a different project. Grok threads continue to surface as "usage not reported".

## 8. A shipped bug this surfaced

Independent of PTY: `routes/analytics.ts:101` calls the **Claude-only**
`resolveTranscriptPath` for every provider. For a Codex terminal it always returns
undefined, so Codex threads silently import zero rows today. Once this design supplies a
Codex locator, make the importer provider-aware and it gets Codex history for free.

## 9. Risks and open unknowns

| Risk | Response |
|---|---|
| Claude's transcript may not be append-only across `/compact` | A shorter-than-cursor file resets rather than desyncs |
| A close event may not fire exactly once per turn under a crash | Same class as the structured recorder's; `closeInterruptedTurns` is the precedent |
| `total_token_usage` may reset outside `/compact` — only one file traced deeply | The negative-diff guard catches it; log so it is visible |
| The anomalous post-compaction `last_token_usage` is unexplained | We do not use `last_token_usage`, so it cannot affect us |
| Codex bucket scan grows over time | 441 files costs 0.00s; revisit only if that changes by orders of magnitude |

## 10. Testing

- A Claude close writes one row summed from only the new bytes; a second close does not
  re-read the first range.
- A first-sight thread bootstraps at end of file and writes **no** history-dump row.
- A Codex close writes the diff of totals, and a fixture where `last_token_usage` disagrees
  with the diff proves we use the diff. This test is the guard on the 0.96% overcount.
- A mid-session `/model` switch attributes each turn to its own model.
- A negative diff records zero and resets rather than writing a negative row.
- A crash between row and state leaves no double count (transaction test).
- A relocated Claude thread starts fresh on the new file.
- A Grok thread writes nothing.
- The Codex locator finds a file whose local-time bucket differs from its UTC date.
