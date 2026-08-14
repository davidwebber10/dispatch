# Codex transcript findings: locator, delta, and model name

Date: 2026-08-14
Status: investigation only — no code written
Branch: `worktree-analytics-usage`

Builds on `docs/superpowers/specs/2026-08-14-pty-usage-coverage-scoping.md` §1, which
already established the file location pattern, the event type list, and that no
`{type:'assistant', message:{usage}}` frame exists. This doc answers the three open
questions from that scoping pass, using real files under `~/.codex/` (read-only) and a
read-only query against `~/.dispatch/dispatch.db`.

---

## 1. Locating a Codex transcript from `external_id` + `working_dir`

**The uuid in the filename equals `external_id` exactly.** Verified against 5 real
Codex terminals pulled from `~/.dispatch/dispatch.db` (`terminals` table, `type='codex'`,
`external_id` non-null):

| `terminals.external_id` | matching file |
|---|---|
| `019fc00c-05a1-77e1-9454-823640aa75da` | `sessions/2026/08/01/rollout-2026-08-01T21-17-21-019fc00c-05a1-77e1-9454-823640aa75da.jsonl` |
| `019fb678-d13c-7d02-b46d-9d0c2533649f` | `sessions/2026/07/31/rollout-2026-07-31T00-39-59-019fb678-d13c-7d02-b46d-9d0c2533649f.jsonl` |
| `019fb193-a506-7632-90a1-88ad1c80efc0` | `sessions/2026/07/30/rollout-2026-07-30T01-51-11-019fb193-a506-7632-90a1-88ad1c80efc0.jsonl` |
| `019f534c-1b95-7761-9658-367768e4e3ea` | `sessions/2026/07/11/rollout-2026-07-11T18-28-44-019f534c-1b95-7761-9658-367768e4e3ea.jsonl` |
| `019f4839-d41c-7e91-add2-04816ae42751` | `sessions/2026/07/09/rollout-2026-07-09T14-52-57-019f4839-d41c-7e91-add2-04816ae42751.jsonl` |

5/5 matched, one-to-one, no collisions. `external_id` alone (a UUIDv7-shaped string) is
enough to disambiguate — `working_dir` is not needed to find the file, only to confirm
you found the right one.

**`session_index.jsonl` exists but is useless as a path locator.** It's real
(`~/.codex/session_index.jsonl`, 39 lines), but:
- It hasn't been updated since **2026-06-08** — `sessions/` has files through **2026-08-12**.
  It is stale by over two months on this machine.
- Its records are `{"id", "thread_name", "updated_at"}` only — **no path field at all**,
  even for the entries it does have. It maps id → display name for some UI (probably
  the Codex TUI's resume picker), not id → file path.

So it cannot be used, even hypothetically if it were kept current — the schema doesn't
carry what's needed.

**A locator has to scan.** On this machine: `sessions/` holds **441** `.jsonl` files
under **51** date-leaf directories (`YYYY/MM/DD`), 3.3 GB total. `archived_sessions/` is
flat (no date structure) with **4** files, 3.9 MB total.

Cost of a scan: a `find ~/.codex/sessions -name "*<uuid>*"` glob-by-filename (no file
content read) completed in **0.00s** (`/usr/bin/time -p`, real/user/sys all `0.00`) at
this scale — filename matching over 441 dirents is free. This would stay cheap into the
low thousands of files; it would only become worth indexing if the session count grew
by 1-2 orders of magnitude, or if the lookup needed to run on a hot path per-request
rather than once at capture time.

**Timezone gotcha, verified with real data — do not derive the date bucket from a UTC
timestamp naively.** The path's `YYYY/MM/DD` and the filename's `rollout-<timestamp>`
are in the machine's **local** timezone (`EDT`, confirmed via `date +%Z`). `terminals.created_at`
in the database is UTC. Example, terminal `8c57a866-b4d3-4afd-a6c2-f139c7d4234e`:

- DB `created_at`: `2026-08-02T01:17:19.192Z` (UTC)
- Actual file: `sessions/2026/08/01/rollout-2026-08-01T21-17-21-...jsonl`

01:17 UTC on Aug 2 is 21:17 EDT on Aug 1 (UTC-4) — the UTC date and the local bucket
date are **different calendar days**. A locator that converts `created_at` to a date
string in UTC and looks only in that day's directory will miss the file for any session
that started after ~20:00 local time. The fix is either to convert to local time before
computing the bucket, or to scan the expected day plus the adjacent day, or (simplest,
given the scan is free) to just scan across the small date-directory set entirely and
match on filename rather than pre-computing a single expected path.

**Archived sessions matter for historical import, not for live capture.** All 4 files in
`archived_sessions/` predate 2026-04-15 and are flat (no date bucketing — a locator
checking there needs a separate, non-date-bucketed glob). A live-capture locator that
runs shortly after a turn completes will find the transcript under `sessions/`, since
Codex only moves things to `archived_sessions/` later. A backfill/import job, by
contrast, must check both locations to avoid silently skipping old sessions — the
scoping note's already-flagged Codex backfill gap (`routes/analytics.ts` calling the
Claude-only resolver) would need to check both trees once fixed.

---

## 2. Is `last_token_usage` a reliable per-turn delta?

Tested against a real, non-forked, top-level Codex session:
`sessions/2026/08/01/rollout-2026-08-01T21-17-21-019fc00c-05a1-77e1-9454-823640aa75da.jsonl`
(3,263 lines, 649 `token_count` events, 27 `task_started`/23 `task_complete` pairs, 4
`turn_aborted`, 3 `context_compacted`/`compacted`, spanning 2026-08-01 through 2026-08-05).

**`total_token_usage` is monotonically non-decreasing across the whole file, with zero
exceptions** — checked all 648 consecutive transitions, 0 decreases, even across all 3
compaction events. Compaction does **not** reset the running total; it keeps climbing
(14,553 at the first event to 80,151,270 at the last).

**In the normal case, `last_token_usage` is exactly the delta of consecutive
`total_token_usage` values** — i.e. `last_i == total_i - total_{i-1}`. Example, the
session's first turn (`task_started` at line 1, 5 requests before `task_complete` at
line 36):

```
line 15: total=14553   last=14553   (first event, last==total)
line 21: total=29475   last=14922   (29475-14553=14922, matches)
line 27: total=45007   last=15532   (45007-29475=15532, matches)
line 31: total=61256   last=16249   (61256-45007=16249, matches)
line 35: total=84397   last=23141   (84397-61256=23141, matches)
```

**But `last_token_usage` is per-*request*, not per-*turn*** — multiple `token_count`
events fire within one `task_started`→`task_complete` span, one per model round-trip
(each tool call that provokes another model call grows the running context and emits
another event). Example turn (`task_started` line 76 → `task_complete` line 102, 4
requests):

```
27159 + 27738 + 29071 + 29201 = 113169
total at line 101 (297501) - total before turn (184332, from line 73) = 113169  -- matches
```

So **summing every `last_token_usage` within a turn's boundary telescopes to the same
number as diffing `total_token_usage` from before the turn to the turn's last event** —
in the normal case, either approach gives the right per-turn number. Using only the
single last `token_count` event's `last_token_usage` for a multi-request turn would
**undercount** badly (29,201 vs. the true 113,169 for the turn above).

**Where the invariant breaks — 9 of 648 transitions (1.4%) in this one file** — every
one of these is `diff(total) == 0` while `last_token_usage` reports a nonzero value:

| line | context | `last_token_usage` reported despite 0 total-diff |
|---|---|---|
| 226, 1069, 2364 | back-to-back duplicate `token_count` emission, no request between | 45108, 53983, 180275 |
| 368, 600, 2439 | the event immediately preceding a `turn_aborted` | 75527, 168656, 190241 |
| 948, 1690, 2515 | the event immediately after a `context_compacted`/`compacted` pair | 12815, 11848, 14655 |

Concretely for this file: summing **every** `last_token_usage` end-to-end gives
80,904,378, while the true growth (`final total - first total`) is 80,136,717 — a naive
sum **overcounts by 767,661 tokens (0.96%)** purely from these 9 anomalous events.

**Compaction detail** (checked all 3 occurrences): the `compacted` (top-level) and
`event_msg:context_compacted` pair appear mid-turn (a turn can start before compaction
and finish after it — `turn_context` for the same `turn_id` repeats once before and once
after). `total_token_usage` does not reset at compaction; the very next `token_count`
event reports the **same** total as pre-compaction, with an unrelated `last_token_usage`
value (looks like the size of the injected compaction summary, not a running delta).
No negative-diff case was observed anywhere in this file — the "would a naive diff go
negative" scenario did not materialize on this sample.

**Conclusion**: diff `total_token_usage` across turn boundaries (last `token_count`
event at/before this turn's `task_complete`, minus the last `token_count` event before
this turn's `task_started`), rather than summing `last_token_usage`. Diffing totals is
robust to the duplicate-emission, aborted-turn, and post-compaction anomalies found
above, because those all report `diff(total)==0` regardless of what `last_token_usage`
claims — summing would silently ingest that spurious value, diffing would not.

---

## 3. Where the model name comes from

**`session_meta`'s own `model` field is `null`** — checked the one `session_meta` line
in the sample file; it carries `session_id`, `id`, `cwd`, `originator`, `cli_version`,
`model_provider` (`"openai"`), `context_window`, `base_instructions`, etc., but no usable
model id.

**`turn_context` carries it, once per turn.** The sample file has 30 `turn_context`
events (`model`, `effort`, `turn_id`, plus `sandbox_policy`, `approval_policy`, etc.),
one for (almost) every `task_started`. A turn interrupted by compaction can get a second
`turn_context` with the *same* `turn_id` (line 614 and line 947 both carry
`turn_id: "019fcb30-..."`) — repetition, not conflicting values.

**The exact string is a codename id, not a bare version number** — confirmed two
distinct real values on this machine: `"gpt-5.6-sol"` and `"gpt-5.6-terra"` (grepped
across all of `sessions/2026/07/` and `/08/`: 28,502 and 8,986 occurrences respectively
of `sol` across July/August, 10 of `terra` in July). Shape is `gpt-<version>-<codename>`.
`effort` is a separate field (`"low"`, `"high"`, `"ultra"` observed) — not part of the
model string.

**Confirmed real mid-session model switch** (not merely effort) — file
`sessions/2026/07/09/rollout-2026-07-09T14-52-57-019f4839-d41c-7e91-add2-04816ae42751.jsonl`:

```
turn 1 (line 7):  model=gpt-5.6-terra  effort=ultra
turn 2 (line 17): model=gpt-5.6-terra  effort=ultra
turn 3 (line 27): model=gpt-5.6-terra  effort=ultra
turn 4 (line 87): model=gpt-5.6-sol    effort=ultra
```

So yes, mid-session `/model` switches are real and appear on this machine, not just a
theoretical case. Attribution is exactly per-turn: each turn's own `turn_context` event
gives the model that applied to that specific turn — turns 1-3 bill against
`gpt-5.6-terra`, turn 4 onward bills against `gpt-5.6-sol`. No special-case reset
logic is needed beyond reading each turn's own `turn_context`, in turn order.

Separately (from a different sample, a forked/subagent-thread file,
`sessions/2026/08/09/rollout-2026-08-09T09-18-19-...jsonl`), the same
per-turn-`model`/mid-session-`effort`-change pattern was observed (effort moved from
`low` to `high` partway through, model string constant) — consistent with the above,
though that file is a subagent fork replay (`thread_source: "subagent"`), not a normal
top-level Dispatch-driven Codex terminal, so it wasn't used as primary evidence.

---

## What I could not determine from files on this machine

- Whether `total_token_usage` ever *does* go negative or reset under some condition not
  present in the one file I traced in depth (e.g. a session hitting a provider-side
  context-window hard reset outside `/compact`). I checked one large, representative,
  non-forked file with 3 real compactions and found zero decreases across 648
  transitions — but that is one file's history, not a proof for all cases.
- Whether the anomalous `last_token_usage` value right after compaction (e.g. `12815`)
  has any actual meaning (size of the compacted summary?) — I can see the number but
  found nothing in the file that labels what it represents.
- Whether `session_index.jsonl` is actively written by a current Codex version at all,
  or is a leftover from an old version that stopped maintaining it after 2026-06-08 —
  I only checked file contents/mtimes, not Codex's source.

## Report path

`/Users/davidwebber/Sites/dispatch/.claude/worktrees/analytics-usage/docs/superpowers/specs/2026-08-14-codex-transcript-findings.md`
