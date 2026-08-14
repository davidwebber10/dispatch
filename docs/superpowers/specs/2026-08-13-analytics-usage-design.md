# Analytics view — usage, throughput, and personal stats

Date: 2026-08-13
Status: design, awaiting approval
Branch: `worktree-analytics-usage` (worktree, based on `944f527` — Grok merged)

## 1. Purpose

Dispatch records numbers today, but it aggregates almost none of them. This design
adds one recorder and one new view. The view answers three questions:

1. **Token burn.** How many tokens did I use, by model, by project, over time?
2. **Throughput.** How many turns ran, how long did they take, how did they end?
3. **Personal stats.** All-time totals, the busiest day, the longest thread, the
   most-used model, the active-day streak.

## 2. What Dispatch records today

| Store | Numbers | Time series? |
|---|---|---|
| `agent_runs` table | `cost_usd`, `total_tokens`, `input_tokens`, `output_tokens`, `model`, `num_turns`, `started_at`, `completed_at`, `status`, `exit_code` | Yes — one row per scheduled run |
| `terminals` table | `status`, `created_at`, `last_activity_at`, `archived_at`, and `config.model` / `config.totalTokens` / `config.outputTokens` | No — one lifetime total per thread |
| `sessions` table | `created_at`, `last_activity_at`, `archived_at`, `provider` | No |
| Transcripts on disk | Per-message `usage`, timestamps, model names | Yes, but nothing aggregates them |

There is no analytics table, no event log, and no telemetry. Dispatch sends nothing
off the machine. This design does not change that.

## 3. Decisions

| Decision | Choice |
|---|---|
| How data arrives | The daemon records each turn as it happens, from the events it already emits. No background job. No polling. |
| History | The table starts empty. A manual, one-off backfill button can import the past. |
| Sources | Dispatch threads only, across every provider that runs in structured mode. |
| Scheduled runs | The `agent_runs` dashboard stays as it is. A scheduled run's *thread* records turns like any other thread. |
| Placement (desktop) | A third top-level view, beside Workspace and Board. |
| Placement (mobile) | A fifth tab in the bottom bar. |
| Charts | Recharts. |
| Cost | A notional figure. Tokens are the primary metric. |

## 4. Cost is notional

Claude Code reports a `cost_usd` per run. On a subscription plan that number is
not a bill. It is the price the same tokens would cost at API rates.

Rules:

- Tokens are the headline metric everywhere.
- The dollar figure appears as a secondary tile, labelled **"equivalent API value"**.
- The price table moves out of `routes/state.ts:100` into one shared module,
  `packages/core/src/analytics/pricing.ts`, with current model identifiers. The
  table in the route today is stale.
- A model with no price entry contributes tokens but not dollars, and the tile
  shows a "partial" marker.

## 5. What the daemon can and cannot see

Turn boundaries are already events. `server.ts:118-175` wires them:

| Event | Meaning |
|---|---|
| `busy` | a turn started |
| `idle` | a turn ended normally |
| `needs-help` | a turn ended by asking the human |
| `scheduled` | a turn ended dormant, waiting on a timer |
| `exit` | the process ended |
| `event` | every frame the CLI emitted, including assistant messages with `usage` |

`noteTurnOutcome` (`server.ts:155`) already runs on every turn end, for **every**
structured thread. That is the insertion point.

**Do not hook `noteAgentCompletion`.** It returns early on `cfg.role !== 'agent'`
(`service.ts:1117`), so it never runs for ordinary chat threads. Hanging analytics
off it would silently drop a large part of the usage.

**Usage rides the event stream.** The manager re-emits every frame at
`manager.ts:334`. Claude's stream-json assistant messages carry a `usage` block,
and `structured/codex-translate.ts` normalizes Codex frames into the same shape.
So one recorder reads both. Live recording needs no per-provider usage parser,
and reads no file. The only per-provider transcript reader in this design belongs
to the optional importer in section 8, which never runs on a hot path.

**PTY threads emit nothing.** A thread in PTY mode — Grok, and any provider with
`statusStrategy: 'pty-timing'` — never passes through the structured manager. It
produces no turn events and no usage. Grok's own source says why
(`providers/grok.ts:65-72`): its runner prints plain text, because its
`streaming-json` emits ACP session updates that `RunStreamParser` cannot read.

Such a thread is marked **"usage not reported"**. The UI never prints 0 for it,
and it is excluded from token totals and from every denominator.

## 6. Data model

One new table, created with `CREATE TABLE IF NOT EXISTS` in `db/schema.ts`. No
existing column changes.

```sql
CREATE TABLE IF NOT EXISTS usage_turns (
  id                  TEXT PRIMARY KEY,
  terminal_id         TEXT NOT NULL,
  project_id          TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL DEFAULT '',
  role                TEXT NOT NULL DEFAULT '',   -- 'agent' | 'coordinator' | ''
  started_at          TEXT NOT NULL,              -- ISO
  ended_at            TEXT,                       -- NULL while the turn is open
  outcome             TEXT,                       -- idle | needs_help | scheduled | exit | interrupted
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  messages            INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  backfilled          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_turns_started  ON usage_turns(started_at);
CREATE INDEX IF NOT EXISTS idx_usage_turns_terminal ON usage_turns(terminal_id);
CREATE INDEX IF NOT EXISTS idx_usage_turns_project  ON usage_turns(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_usage_turns_open     ON usage_turns(ended_at) WHERE ended_at IS NULL;
```

The grain is **one row per turn**. It is richer than a daily rollup and costs
little: a heavy month writes a few thousand rows. Every chart is a `GROUP BY`
over an indexed column.

The turn grain gives throughput for free — duration from
`ended_at - started_at`, and an outcome mix from `outcome`. That partly restores
the success signal lost by leaving `agent_runs` out: a thread has no pass or fail,
but a turn that ended `idle` is a different thing from one that ended `needs_help`
or `exit`.

Two keys in `app_state`:

- `analytics_tracking_started_at` — the instant recording began. Written once.
- `analytics_backfill_state` — the importer's progress record.

## 7. The recorder

A new module, `packages/core/src/analytics/recorder.ts`, subscribes to the
structured manager. It holds no aggregate of its own; the table is the only state.

| Event | Action |
|---|---|
| `busy` | Open a row: `started_at = now`, `ended_at = NULL`. Capture `terminal_id`, `project_id`, `provider`, `role`, and `model` from the terminal row. |
| `event` with `message.usage` | Add the usage to the open row, and increment `messages`. Take `model` from the frame when the row has none. |
| `event` with a `tool_use` block | Increment `tool_calls`. |
| `idle` / `needs-help` / `scheduled` | Close the row: set `ended_at` and `outcome`. |
| `exit` | Close any open row for that terminal with `outcome = 'exit'`. |

Two rules keep it correct:

- **One writer.** Nothing else adds tokens to this table. Dispatch has shipped a
  token double-count bug once already, and two independent adders on one counter
  is how that happens. `persistAgentTokenUsage` keeps writing `config.totalTokens`
  for the Done cards, and it stays completely separate from `usage_turns`.
- **Write through, do not buffer.** Usage is added to the row as each frame
  arrives, not held in memory until the turn ends. A daemon restart mid-turn then
  loses nothing. Each write is a single indexed row update.

**Restart handling.** On daemon start, any row still open is closed with
`outcome = 'interrupted'` and `ended_at = started_at`. A restart therefore leaves
an honest record, not a phantom turn of infinite length. The charts count an
interrupted turn's tokens but exclude it from duration statistics.

**Failure policy.** Every recorder call is best-effort and wrapped. Analytics must
never break a turn. A write that throws is swallowed and counted in a debug log.

## 8. Backfill — manual, one-off, bounded

The table starts empty. The Analytics view offers a **"Import history"** button.

- The importer reads the transcripts of threads Dispatch knows about, and writes
  turn rows with `backfilled = 1`.
- It accepts **only** data older than `analytics_tracking_started_at`. Live
  recording owns everything after that instant, so the two can never overlap and
  the button cannot double-count.
- It is idempotent. A re-run deletes rows where `backfilled = 1`, then rebuilds
  them. Live rows are never touched, so a cancelled or failed import cannot damage
  a real measurement.
- It runs only when the human presses the button. It reports progress, and it can
  be cancelled. It is not a background job, and it never runs on daemon start.
- The importer needs a per-provider transcript reader. This is the only place that
  code exists, and it is off every hot path. Claude Code and Codex get one; Grok
  does not, so Grok threads import nothing.
- Charts can shade or exclude backfilled turns, because the flag distinguishes an
  imported turn from a measured one.

An imported turn carries the tokens and the model that its transcript records. It
carries no reliable duration, so `ended_at` equals `started_at` and the turn is
excluded from duration statistics.

## 9. API

New router at `packages/core/src/routes/analytics.ts`. Every route reads
`usage_turns` and never touches a transcript.

| Route | Returns |
|---|---|
| `GET /api/analytics/summary?from&to&projectId` | KPI tiles: tokens, output tokens, turns, threads, notional value, unknown-usage thread count |
| `GET /api/analytics/series?metric&groupBy&bucket&from&to&projectId` | A dated series. `metric` = `tokens` \| `outputTokens` \| `turns` \| `duration`. `groupBy` = `model` \| `provider` \| `project` \| `outcome` \| `none`. |
| `GET /api/analytics/top?dimension&from&to` | Ranked rows: top projects, top threads, model mix |
| `GET /api/analytics/records` | Personal stats: all-time totals, busiest day, longest thread, active-day streak |
| `GET /api/analytics/backfill` | `{ trackingStartedAt, state, done, total, lastFinishedAt }` |
| `POST /api/analytics/backfill` | Start the import |
| `DELETE /api/analytics/backfill` | Cancel a running import, or remove imported rows |

The view refreshes over the existing WebSocket. The recorder emits a lightweight
`analytics-dirty` signal when it closes a turn, so an open Analytics page updates
as you work, with no polling.

## 10. UI

### Desktop

`stores/ui.ts` defines `View = 'workspace' | 'board'`, and `App.tsx:192` switches
on it. Add `'analytics'` as a third member. This is the pattern Board mode already
established, so the shell needs no restructure.

### Mobile

`components/mobile/MobileApp.tsx` holds
`bottomTab: 'projects' | 'pinned' | 'agents' | 'settings'`. Add `'analytics'` as a
fifth tab. Five is the practical maximum for that bar. The screen stacks to one
column, and each chart keeps a minimum height so the marks stay legible.

### The page

A filter row sits above the charts: project, date range (7 / 30 / 90 days / all),
and provider. Filters never repaint the surviving series — a model keeps its color
when another model is filtered out.

| # | Block | Form | Why this form |
|---|---|---|---|
| 1 | Headline totals | Stat tiles, no plot | A single number needs no chart |
| 2 | Tokens over time | Stacked bar, one segment per model | Magnitude over time, split by identity |
| 3 | Output tokens over time | Line | The "real work" signal, less noisy than the cache-dominated total |
| 4 | Turns per day, by outcome | Stacked bar | A count over time, with the outcome mix |
| 5 | Turn duration | Bar, by bucket | Distribution, not an average that hides the tail |
| 6 | Model mix | Horizontal ranked bar | Part-to-whole compared by length, not by angle. Not a pie. |
| 7 | Top projects | Horizontal ranked bar | Ranking |
| 8 | Activity calendar | Heatmap, sequential single hue | The personal-stats block |
| 9 | Personal records | Number list | Facts, not trends |

Rules taken from the dataviz method:

- Never a dual-axis chart. Tokens and turn counts get separate charts.
- A legend is always present for two or more series. Four or fewer series are also
  direct-labelled, so identity is never carried by color alone.
- Marks are thin, with a 2px surface gap between stacked segments.
- Every chart has a hover tooltip.
- Grid and axes stay recessive, in `--color-text-tertiary`.

### Colors

Dispatch is dark-only. `theme.css` offers three chart-usable colors, and all three
are **status** colors: `--color-accent` `#3ECF6A`, `--color-status-yellow`
`#F5C542`, `--color-status-red` `#F0616D`. A status color must never stand in for
"series 4", or a model starts to look like a failure.

So the view adds its own categorical palette, validated against the Dispatch pane
surface `#141416`:

| Slot | Hex | Assigned to |
|---|---|---|
| 1 | `#3987e5` | first model, in fixed order |
| 2 | `#d95926` | second |
| 3 | `#199e70` | third |
| 4 | `#c98500` | fourth |
| 5 | `#d55181` | fifth |

Validator result, dark mode on `#141416`: lightness band PASS, chroma floor PASS,
CVD separation PASS (worst adjacent pair ΔE 8.4, protan), normal-vision floor PASS
(worst 19.3), contrast PASS. All checks pass.

Hues are assigned in fixed order and never cycled. A sixth model folds into
"Other", in a neutral gray.

The outcome chart is the one exception: `idle`, `needs_help`, and `exit` are
states, not identities, so they wear the reserved status colors with an icon and a
label, exactly as a status should.

The heatmap uses a single-hue sequential ramp built from the accent green, from
near-surface at the low end to full accent at the high end, with monotonic
lightness.

**Recharts and CSS variables.** Recharts needs literal color values; it cannot
take `var(--color-accent)`. A small `chartTheme.ts` reads the computed custom
properties once at mount and exports hex strings, so `theme.css` stays the single
source of truth.

## 11. Other users, and the update

- The migration is additive, following `db/schema.ts:148`. An older database
  upgrades in place, and a downgrade still runs.
- Nothing runs on daemon start except closing interrupted rows, which is a single
  indexed statement.
- A new user's charts start empty and fill as they work. The "Import history"
  button is there if they want the past.
- Nothing leaves the machine. The recorder stores token counts, timestamps, model
  names, and outcomes. It stores no message text, and it makes no network call.
- Recharts adds roughly 100 kb to the web bundle. The view is lazy-loaded with
  `React.lazy`, so the chart code stays out of the initial chunk.

## 12. Testing

Core:

- A `busy` → `event` → `idle` sequence writes exactly one closed row with the
  right totals.
- A turn with several assistant frames sums them once. Replaying the same frame
  twice does not double the count. This is the direct guard against the
  double-count bug.
- A chat thread with `role !== 'agent'` records a turn. This is the regression
  test for the `noteAgentCompletion` trap.
- `needs-help`, `scheduled`, and `exit` each close the row with the right outcome.
- An open row left by a crash closes as `interrupted` on the next start, and does
  not produce an enormous duration.
- A PTY thread writes no row, and reads back as "usage not reported", which is not
  the same state as a thread with no turns yet.
- A recorder write that throws does not break the turn.
- The importer refuses data at or after `analytics_tracking_started_at`.
- Running the importer twice yields the same totals, and leaves live rows
  untouched.
- Day bucketing across midnight and across a timezone offset.

Web:

- The summary and series derivations.
- The view renders with no data, with an unknown-usage thread, and with backfilled
  rows present.

End to end: the isolated-instance pattern — a daemon on a fake `HOME` and port
3999 — so no test touches the real `~/.dispatch`.

## 13. Out of scope

- Any export to CSV or to a sheet.
- Per-skill analytics.
- Folding `agent_runs` into these charts. That dashboard stays as it is.
- Recording sessions that Dispatch did not create.
- Aggregation across machines.

## 14. Risks

| Risk | Response |
|---|---|
| PTY threads, including Grok, report nothing | Shown as "usage not reported", never as 0, and excluded from denominators |
| A restart interrupts a turn | The row closes as `interrupted` on the next start, and is excluded from duration statistics |
| Usage is written on every frame, not batched | One indexed row update per frame; that is far cheaper than the transcript read the daemon already does at turn end |
| The importer overlaps live data | The `analytics_tracking_started_at` cutoff makes overlap impossible |
| The price table goes stale | One shared module, and a test that fails on an unpriced model Dispatch can spawn |
| Bundle growth from Recharts | The view is lazy-loaded |
| Local timezone shifts day boundaries | Bucket in local time, state that in the UI, and test the boundary |
