# Scoping note: can the analytics recorder cover PTY threads?

Date: 2026-08-14
Status: scoping only — no code written, no recommendation implemented
Branch: `worktree-analytics-usage`

## 1. The signal available

### Claude Code PTY — a real signal exists, and it is mostly already flowing

A Claude Code PTY thread carries `statusStrategy: 'hooks'`
(`packages/core/src/providers/claude-code.ts:52`). Its session id (`external_id`) is
captured two independent ways:

- `captureSessionId` (`claude-code.ts:140-168`) polls `~/.claude/projects/<encoded-workdir>/`
  for a `.jsonl` born after spawn time, for up to 30s.
- Every hook POST (`SessionStart`, `Stop`, etc.) carries `session_id` in its payload.
  `normalizeClaude` (`packages/core/src/status/events.ts:21-47`) extracts it, and
  `StatusService.ingest` (`packages/core/src/status/service.ts:54-64`) writes it to
  `terminal.external_id` the first time it sees a healthy id — this path does not
  depend on `captureSessionId` succeeding at all.

The working dir is always available: `terminal.working_dir`, with a fallback to
`session.working_dir` (used already in `routes/analytics.ts:99`). `resolveTranscriptPath`
(`packages/core/src/sessions/transcript-path.ts:53`) turns `(workDir, sessionId)` into a
transcript path, with a full-project-directory search fallback for a relocated thread
(e.g. after `EnterWorktree`). This is the exact file the *structured* Claude thread
writes too — same CLI, same transcript format — so the existing frame parser
(`analytics/frames.ts`) already reads it correctly; this was verified against the
importer, which parses this same file shape today.

**Real capture rate**, from the user's own database (`~/.dispatch/dispatch.db`, read-only):
of 88 currently-**active** Claude Code PTY threads, 87 (98.9%) have an `external_id`.
Across all time (including 205 archived threads going back to March), 167/195 (85.6%)
do. The missing ones are overwhelmingly old/archived threads, consistent with threads
that never sent a message or predate one of the two capture paths.

### Codex PTY — an id exists, but the transcript is a different, unbuilt problem

Codex PTY carries `statusStrategy: 'pty-timing'` (`providers/codex.ts:32`), but that label
is about the *busy* signal, not the *close* signal — see §2. Codex's `notify` hook
(`codex.ts:47-54`) reports a `thread-id` on every `agent-turn-complete`, and
`normalizeCodex` (`status/events.ts:50-58`) captures it the same way Claude's does. Active
capture rate: 11/13 (84.6%) of currently-active Codex PTY threads have an `external_id`;
across all time it's 16/36 (44.4%), because most of the id-less rows are archived.

But the transcript itself is a **different file entirely**, and the plumbing to read it
does not exist:

- Location: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<uuid>.jsonl` (live) or
  `~/.codex/archived_sessions/rollout-<timestamp>-<uuid>.jsonl` (archived) — not
  `~/.claude/projects/...`, and not addressable by `(workDir, sessionId)` alone the way
  `resolveTranscriptPath` assumes; it needs a date-bucketed scan or `session_index.jsonl`.
- Format: I inspected a real transcript on this machine. It has no `{type:'assistant',
  message:{usage}}` frames at all — the events are `token_count`, `event_msg`,
  `response_item`, `turn_context`, etc. A usage sample from that file:

  ```json
  {"type":"event_msg","payload":{"type":"token_count","info":{
    "total_token_usage":{"input_tokens":25591,"cached_input_tokens":11008,
      "output_tokens":487,"reasoning_output_tokens":343,"total_tokens":26078},
    "last_token_usage":{"input_tokens":25591,"cached_input_tokens":11008,
      "output_tokens":487,"reasoning_output_tokens":343,"total_tokens":26078}
  },"rate_limits":{...}}}
  ```

  `last_token_usage` is a usable per-turn delta, but nothing in `frames.ts` can read this
  shape — it needs its own parser, and the model name isn't in this payload at all (it
  would have to come from a `turn_context` or `session_meta` event elsewhere in the file).

**Correction to the existing design doc and to the current backfill code**: the design
doc (`docs/superpowers/specs/2026-08-13-analytics-usage-design.md`, §8) states "Claude
Code and Codex get one [transcript reader]." That is not true today.
`routes/analytics.ts:9,101` calls `resolveTranscriptPath` from `sessions/cc-sessions.ts`
— the Claude-only resolver — for **every** provider type, Codex included. For a Codex
terminal this always returns `undefined` (Codex never writes under
`~/.claude/projects`), so `fs.readFileSync` never runs and Codex threads silently import
zero rows from backfill today, exactly like Grok. This isn't a PTY-specific gap — it's a
gap in the already-shipped importer, independent of anything in this scoping task, and
worth flagging separately.

### Grok — categorically uncoverable

Confirmed in `providers/grok.ts:26-45`: no `buildStatusHooks`, no `captureSessionId`. Its
`--single` runner deliberately stays `plain` output because Grok's `streaming-json` speaks
ACP, which nothing in Dispatch parses. There is no transcript file, no session id capture
path, and no event of any kind. Database confirms: both Grok PTY rows (100% of Grok
threads) have no `external_id`. No mechanism proposed here or elsewhere can cover Grok
without first building a Grok ACP parser and a status/notify integration — a materially
different, larger project.

## 2. The turn-boundary problem — better news than the task brief assumed

The task brief frames `statusStrategy: 'pty-timing'` as a timing heuristic that "would
mis-attribute tokens across turns." That's true of the **busy** signal (PTY output-byte
timing, `sessions/status.ts` `ptyStatusTick`, `ACTIVITY_THRESHOLD_MS = 4_000`,
`terminal-monitor.ts`'s idle-timer burst detection) — genuinely a heuristic, genuinely
capable of firing early or late.

But the **close** signal is not that heuristic, for either of the two real providers:

- **Claude Code**: the `Stop` hook (`normalizeClaude`, `status/events.ts:42`) is a
  first-class Claude Code lifecycle event, sent once per turn regardless of transport.
  It already flows through `StatusService.ingest` → `apply()` → `idle`, and it is the
  same mechanism that already closes a turn for status purposes today. It is not timing;
  it is the CLI's own declaration that the turn ended.
- **Codex**: `agent-turn-complete`, delivered via the `notify` program Codex itself
  invokes (`codex.ts:47-54`, `normalizeCodex`, `status/events.ts:55`). Also a first-class,
  event-driven signal, not timing. `sessions/status.ts:51` skips the byte-timing loop
  entirely for `statusStrategy: 'hooks'` providers (Claude) but *not* for Codex — meaning
  Codex currently runs both the notify-driven status flip and the byte-timing loop
  concurrently. That's an existing quirk of the status system, not something new this
  investigation introduces, but it means Codex's `pty-timing` label describes the
  *busy* half only; the *close* half is event-driven, same as Claude.

**Reliability caveat, unverified**: I found no test or comment asserting the `Stop` hook
or `agent-turn-complete` notify fires exactly once per turn under every condition
(a killed CLI process, a network hiccup delivering the HTTP hook POST, a crash mid-tool-call).
`closeInterruptedTurns` exists precisely because the *structured* manager's equivalent
events can go missing on a daemon restart — the same class of failure applies here and
isn't uniquely a PTY problem, but nothing in the current code specifically hardens the
hook-delivery path (`POST /api/events/claude/:terminalId` failing silently, say, if the
daemon is mid-restart when the hook fires).

**Conclusion: a turn-boundary signal exists and is event-driven, not timing-inferred, for
Claude Code and Codex PTY threads.** Grok has none.

## 3. Candidate mechanisms

### A — Transcript tail-read on turn close (the one I'd consider building, Claude Code only)

On the `Stop` event (already observed by `StatusService.ingest`), read only the *new*
bytes of the transcript since a per-thread cursor, extract `usage` blocks with the
existing `usageFromFrame`/`toolCallsInFrame` (`analytics/frames.ts` — no new parser needed
for Claude), sum them into one `usage_turns` row, and advance the cursor.

**What it touches:**
- A new per-terminal cursor: a column on `terminals.config` (e.g. `analyticsPtyOffset`)
  or a small new table `usage_pty_cursor(terminal_id, path, byte_offset)`. Small schema
  addition either way.
- A new subscriber on the `Stop`-driven close. `StatusService` today exposes this only as
  a single-callback `threadSettledHook` and doesn't discriminate "closed because idle" from
  "closed because needs_input" cleanly enough to reuse as-is — plumbing a
  recorder-usable event here is a real but modest change, the PTY analogue of what
  `wirePermissionMembrane` already does for the structured `idle` event
  (`server.ts:159-199`).
- Reuse of `db/usage.ts`'s `openTurn`/`addUsage`/`closeTurn` or a new `insertClosed`-style
  call — the same functions the live recorder and the importer already use.

**How it could double-count — this is the part that matters most:**

1. **Bootstrap dump.** A cursor that starts at byte 0 the first time a thread is seen
   would, on the very first `Stop` after this ships, read the thread's *entire* prior
   history and attribute it to one "turn" — badly distorting that turn's stats, and
   duplicating exactly what a future "Import history" press would also cover for the
   same pre-existing content. The cursor **must** bootstrap to end-of-file at
   feature-enable time (or first-sight time), never to 0. This is the direct PTY analogue
   of `analytics_tracking_started_at`, just per-thread-and-byte instead of
   per-timestamp — and it should be floored at that same global cutoff, so a long-idle
   thread that resumes after months away can't backfill through the tail-reader and
   collide with what "Import History" is also entitled to cover.
2. **Crash between row-write and cursor-advance.** If the row is written first and the
   daemon dies before the cursor advances, the next `Stop` re-reads the same range and
   double-counts. If the cursor advances first and the daemon dies before the row is
   written, that turn's tokens are silently lost (safer failure, but still wrong). Needs
   one atomic sqlite transaction covering both — `better-sqlite3` supports this directly,
   but the existing recorder's per-frame "write through, don't buffer" design doesn't have
   this pattern anywhere today; it's new plumbing, not reuse.
3. **Relocation.** `transcript-path.ts`'s own doc comment describes a thread that changes
   cwd (`EnterWorktree`) and keeps writing under a *new* project directory while the old
   session id stays the same. `resolveTranscriptPath` finds the new file by search, but a
   byte offset tracked against the *old* file's path is meaningless against the new one.
   The tail-reader has to detect "the resolved path changed" and treat the new file as
   fresh (offset 0 on the new file is plausible, since Claude Code's own `relocated` marker
   lives at the *start* of the new file — but this is a deliberate design decision this
   scoping note is flagging, not something existing code already handles for this
   use case).
4. **Compaction.** I did not find and did not empirically verify a guarantee that Claude
   Code's transcript file is strictly append-only across a `/compact`. If a compaction
   ever rewrites earlier lines (as opposed to appending a `context_compacted`-style marker
   the way Codex's log does), a byte-offset cursor silently desyncs from the content it
   thinks it's reading. This is an open, unverified risk, not a resolved one.
5. **Second writer to `usage_turns`.** The design doc states the table's core invariant
   plainly: *"Nothing else adds tokens to this table."* A PTY tail-reader is a genuine
   second writer. It cannot literally double-write the *same* row as the live recorder
   (different terminals — a thread is either PTY or structured, never both at once, per
   `sessions/service.ts:862`), but it does mean two independent pieces of code both
   defend the table's correctness instead of one, which is exactly the shape of bug the
   design doc says already bit this project once.

### B — Poll `terminal.config.totalTokens` / `outputTokens` (reject)

`terminals.config` already accumulates a lifetime token total per thread
(`persistAgentTokenUsage`, referenced in the design doc §7's "one writer" rule). Rejected
outright: it's a lifetime counter with no turn boundary at all, would require diffing
against a last-seen value (yet another cursor, with the same crash-ordering problem as
Option A but *worse* because a diff can go negative or reset on a resume), and the design
doc explicitly calls out this exact field as the thing analytics must stay independent of,
having already caused one double-count bug.

### C — Full periodic re-scan / background job (reject)

Re-parsing every known thread's transcript on an interval and diffing against
`usage_turns`. Rejected for the same reason the design doc rejected a background scan for
the *entire* feature (`docs/.../2026-08-13-analytics-usage-design.md` §3, "How data
arrives": *"No background job. No polling."*) — this is exactly the anti-pattern the
existing design was built to avoid, and the user's own standing preference (see memory:
"No background jobs — hook the events") rules it out independent of any technical
concern.

## 4. Real thread counts (read-only query against `~/.dispatch/dispatch.db`)

AI-provider terminals only (excludes `shell`, `file`, `notes`, `browser` — non-AI tab
types that share the `terminals` table but have no provider, no transcript, and are
irrelevant to this question):

| Provider | PTY (all-time) | Structured (all-time) | Total |
|---|---|---|---|
| claude-code | 195 | 213 | 408 |
| codex | 36 | 2 | 38 |
| grok | 2 | 0 | 2 |
| **Total** | **233 (52.0%)** | **215 (48.0%)** | **448** |

Active threads only (`archived_at IS NULL`):

| Provider | PTY | Structured | Total |
|---|---|---|---|
| claude-code | 88 | 115 | 203 |
| codex | 13 | 1 | 14 |
| grok | 0 | 0 | 0 |
| **Total** | **101 (46.5%)** | **116 (53.5%)** | **217** |

This is not a rounding-error blind spot — PTY threads are essentially **half** of all AI
activity, active or historical. Every number above came from a plain read-only
`sqlite3 -readonly` query; no write touched the database. `external_id` presence, the
gating fact for any coverage attempt, is high among **active** threads (99% Claude Code,
85% Codex) and much lower among old archived ones (86% / 44%), which matters only if a
future backfill effort ever wants old PTY history — live coverage going forward only
needs the active-thread numbers.

`usage_turns` currently has 0 rows and `app_state` has no `analytics_tracking_started_at`
key yet — the live recorder hasn't been switched on in this environment, so none of the
above interacts with real recorded data yet.

## 5. Recommendation

**Claude Code PTY: I would build this, scoped narrowly.** The signal is real and mostly
event-driven already (`Stop` hook), the transcript format is one Dispatch already parses
correctly (the importer proves it), external-id capture is 99% reliable on active
threads, and the size of the gap — PTY is roughly half of all Claude Code threads,
195 of 408 all-time, 88 of 203 active — easily justifies the modest scope in §3-A: a
per-thread byte cursor, one new close-event subscriber, and careful attention to the five
double-count risks listed there, especially the bootstrap-at-EOF rule (§3-A.1) and the
atomic offset+row write (§3-A.2). Those two are not optional hardening — skipping either
one reproduces the exact "two adders on one counter" failure mode the design doc says
already happened once.

**Codex PTY: I would not build this now.** The turn-boundary signal is just as real as
Claude's (`agent-turn-complete` notify), but the transcript itself requires building,
from scratch, a new file-locator (dated directory + `rollout-*.jsonl` naming, not
`(workDir, sessionId)`) and a new parser (`token_count.last_token_usage`, no shared shape
with `frames.ts`, model name not co-located with usage). That work doesn't exist anywhere
in this codebase yet — not even in the already-shipped backfill importer, which silently
imports zero Codex history today despite the design doc claiming it covers Codex. Given
Codex is a much smaller slice (38 threads all-time, 14 active, vs. Claude Code's 408/203),
I'd fix the importer's Codex gap first — it's the same underlying parser work this would
also need — before extending live PTY coverage to Codex.

**Grok: I would not build this, full stop.** There is no transcript, no session id, no
event of any kind (§1). Coverage here is not a recorder change; it's a separate project
to give Grok a structured/ACP transport or a notify-equivalent hook, and it's out of
scope for "extend the recorder."

**Net**: partly feasible. Worth doing for Claude Code PTY specifically, given it's the
single largest slice of uncovered usage and the pieces (event-driven close signal,
working parser, reliable id capture) are already mostly in place. Not worth doing yet for
Codex PTY — real but smaller gap, real but unbuilt cost. Not possible for Grok at all.
