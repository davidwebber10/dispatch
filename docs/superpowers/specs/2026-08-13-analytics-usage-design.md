# Analytics view — usage, throughput, and personal stats

Date: 2026-08-13
Status: design, awaiting approval
Branch: `worktree-analytics-usage` (worktree, based on `944f527` — Grok merged)

## 1. Purpose

Dispatch records numbers today, but it aggregates almost none of them. This design
adds one aggregation layer and one new view. The view answers three questions:

1. **Token burn.** How many tokens did I use, by model, by project, over time?
2. **Throughput.** How many threads ran, how long did they take, which projects
   carried the work?
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

The cumulative number on `terminals.config` exists for speed, not for analytics.
`packages/core/src/sessions/service.ts:1226` explains it: the Work-tab Done cards
needed a token count without a per-card fetch.

## 3. Decisions

| Decision | Choice |
|---|---|
| History | Scan transcripts into a rollup table. Incremental after the first run. |
| Sources | Dispatch threads only, across Claude Code, Codex, and Grok. |
| Scheduled runs | The `agent_runs` dashboard stays as it is. A scheduled run's *thread* appears in the new charts like any other thread. |
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
  `packages/core/src/analytics/pricing.ts`, with the current model identifiers.
  The table in the route today is stale.
- A model with no price entry contributes tokens but not dollars, and the tile
  shows a "partial" marker.

## 5. Providers that report no usage

Grok reports nothing to count. `packages/core/src/providers/grok.ts:65-72` states
the reason: the runner uses `--single` with plain output, because Grok's
`streaming-json` emits ACP session updates that `RunStreamParser` cannot read.

A hardcoded Claude-or-Codex parser would show every Grok thread as **0 tokens**,
which reads as "free" instead of "unknown". So usage extraction becomes a
per-provider capability.

Add one optional method to `SessionProvider`:

```ts
readUsage?(workDir: string, externalSessionId: string, fromOffset?: number): UsageScanResult | null;

interface UsageScanResult {
  events: UsageEvent[];   // one per assistant message that carried a usage block
  nextOffset: number;     // byte offset consumed, for the incremental scan
}

interface UsageEvent {
  at: string;             // ISO timestamp from the transcript line
  model: string;          // '' when the line does not name one
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}
```

- `claude-code` implements it. It reuses the logic in
  `sessions/cc-sessions.ts:191` (`sumTranscriptTokens`), refactored to emit dated
  events instead of one total. `sumTranscriptTokens` stays, and becomes a thin
  wrapper so the Done cards keep working unchanged.
- `codex` implements it against the Codex session files.
- `grok` does not implement it. The method is absent.

A provider with no `readUsage` marks its threads **"usage not reported"**. The UI
never prints 0 for them, and they are excluded from token totals and from every
denominator.

Such a thread writes no `usage_daily` row at all. The API derives the unknown set
from the `terminals` table: a thread whose provider has no `readUsage` is
unknown-usage, whether or not it has rows. A thread whose provider *does* report
usage, but which has no rows yet, is simply a thread the scanner has not reached.
The two states are different, and the view labels them differently.

This is the only change to the provider interface. It is additive and optional, so
it does not break the Grok work in flight.

## 6. Data model

Two new tables, both additive, created with `CREATE TABLE IF NOT EXISTS` in
`db/schema.ts`. No existing column changes.

```sql
CREATE TABLE IF NOT EXISTS usage_daily (
  day                 TEXT    NOT NULL,   -- 'YYYY-MM-DD', local time
  terminal_id         TEXT    NOT NULL,
  project_id          TEXT    NOT NULL,
  provider            TEXT    NOT NULL,
  model               TEXT    NOT NULL,   -- '' when the transcript names none
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_create_tokens INTEGER NOT NULL DEFAULT 0,
  messages            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, terminal_id, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day     ON usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_usage_daily_project ON usage_daily(project_id);

CREATE TABLE IF NOT EXISTS usage_scan_state (
  terminal_id     TEXT PRIMARY KEY,
  transcript_path TEXT NOT NULL,
  mtime_ms        INTEGER NOT NULL,
  size_bytes      INTEGER NOT NULL,
  next_offset     INTEGER NOT NULL,   -- bytes already folded into usage_daily
  scanned_at      TEXT NOT NULL
);
```

The grain is **day × thread × model**. That grain answers every question in
section 1 and keeps the table small: a thread active for three days across two
models writes six rows.

Throughput needs no new table. `terminals` already carries `created_at`,
`last_activity_at`, `archived_at`, and `status`.

**Caveat to state in the UI:** a thread has no success or failure outcome. Only
`agent_runs` has that. So the throughput charts count starts, finishes, and
durations. They do not show a success rate.

## 7. Ingest

Two mechanisms write one table.

**Live.** The turn-settled hook in `sessions/service.ts:1226` already runs at the
right moment. It gains one line: mark this terminal dirty and ask the scanner to
fold the tail of its transcript.

The hook does **no arithmetic of its own**. Dispatch has already shipped a token
double-count bug once. Two independent adders on one counter is how that happens.
So there is exactly one adder — the scanner — and the hook only triggers it.

**Reconcile.** A background job walks every non-archived terminal on daemon start,
and hourly after that. For each thread it compares the transcript's `mtime` and
size against `usage_scan_state`:

- Unchanged → skip.
- Grew, and the prefix is intact → parse from `next_offset` only, and add the
  deltas with `INSERT ... ON CONFLICT DO UPDATE SET x = x + excluded.x`.
- Shrank, or the file is new → `DELETE FROM usage_daily WHERE terminal_id = ?`,
  then rebuild that thread from byte 0.

This repairs anything the live hook missed after a crash, a kill, or a resume.

**Scheduling rules:**

- The scan never blocks daemon startup. It runs after boot, on a timer.
- It yields between files, so it never starves the event loop.
- It writes a progress record to `app_state`, so the view can show
  "scanning 340 / 1200 threads" instead of an empty page.
- An interrupted scan resumes. Each file's state is committed as that file
  finishes.

## 8. API

New router at `packages/core/src/routes/analytics.ts`.

| Route | Returns |
|---|---|
| `GET /api/analytics/summary?from&to&projectId` | KPI tiles: tokens, output tokens, threads, notional value, unknown-usage thread count |
| `GET /api/analytics/series?metric&groupBy&bucket&from&to&projectId` | A dated series. `metric` = `tokens` \| `outputTokens` \| `threads`. `groupBy` = `model` \| `provider` \| `project` \| `none`. |
| `GET /api/analytics/top?dimension&from&to` | Ranked rows: top projects, top threads, model mix |
| `GET /api/analytics/records` | Personal stats: all-time totals, busiest day, longest thread, streak |
| `GET /api/analytics/scan-status` | `{ state, done, total, lastFinishedAt }` |
| `POST /api/analytics/rescan` | Force a full rebuild |

Every query reads `usage_daily` only. No route reads a transcript. That is what
keeps the page instant.

## 9. UI

### Desktop

`stores/ui.ts` defines `View = 'workspace' | 'board'`, and `App.tsx:192` switches
on it. Add `'analytics'` as a third member. This is the pattern Board mode already
established, so the shell needs no restructure.

### Mobile

`components/mobile/MobileApp.tsx` holds
`bottomTab: 'projects' | 'pinned' | 'agents' | 'settings'`. Add `'analytics'` as a
fifth tab.

Five is the practical maximum for that bar. The analytics screen stacks to one
column on mobile, and each chart keeps a minimum height so the marks stay legible.

### The page

A filter row sits above the charts: project selector, date range (7 / 30 / 90 days
/ all), and provider filter. Filters never repaint the surviving series — a model
keeps its color when another model is filtered out.

| # | Block | Form | Why this form |
|---|---|---|---|
| 1 | Headline totals | Stat tiles, no plot | A single number needs no chart |
| 2 | Tokens over time | Stacked bar, one segment per model | Magnitude over time, split by identity |
| 3 | Output tokens over time | Line | The "real work" signal, less noisy than total |
| 4 | Threads started per day | Bar | A count over time |
| 5 | Model mix | Horizontal ranked bar | Part-to-whole compared by length, not by angle. Not a pie. |
| 6 | Top projects | Horizontal ranked bar | Ranking |
| 7 | Activity calendar | Heatmap, sequential single hue | The personal-stats block |
| 8 | Personal records | Number list | Facts, not trends |

Rules taken from the dataviz method:

- Never a dual-axis chart. Tokens and thread counts get separate charts.
- A legend is always present for two or more series. Four or fewer series are also
  direct-labelled, so identity is never carried by color alone.
- Marks are thin, with a 2px surface gap between stacked segments.
- Every chart has a hover tooltip. Recharts supplies it.
- Grid and axes stay recessive, in `--color-text-tertiary`.

### Colors

Dispatch is dark-only. `theme.css` offers just three chart-usable colors, and all
three are **status** colors: `--color-accent` `#3ECF6A`, `--color-status-yellow`
`#F5C542`, `--color-status-red` `#F0616D`. A status color must never stand in for
"series 4", or a model starts to look like a failure.

So the analytics view adds its own categorical palette, validated against the
Dispatch pane surface `#141416`:

| Slot | Hex | Assigned to |
|---|---|---|
| 1 | `#3987e5` | first model, in fixed order |
| 2 | `#d95926` | second |
| 3 | `#199e70` | third |
| 4 | `#c98500` | fourth |
| 5 | `#d55181` | fifth |

Validator result on surface `#141416`, dark mode: lightness band PASS, chroma floor
PASS, CVD separation PASS (worst adjacent pair ΔE 8.4 protan), normal-vision floor
PASS (worst 19.3), contrast PASS. All checks pass.

Hues are assigned in fixed order and never cycled. A sixth model folds into
"Other" in a neutral gray.

The heatmap uses a single-hue sequential ramp built from the accent green, from
near-surface at the low end to full accent at the high end. Its lightness must be
monotonic.

**Recharts and CSS variables.** Recharts needs literal color values; it cannot
take `var(--color-accent)`. So a small `chartTheme.ts` reads the computed custom
properties once at mount and exports hex strings. This keeps one source of truth
in `theme.css`.

## 10. Other users, and the update

- The migration is additive. It follows the existing pattern in `db/schema.ts:148`.
  An older database upgrades in place, and a downgrade still runs.
- The first scan runs in the background, never on the startup path. The view shows
  its progress.
- Charts are not empty on first open. The backfill covers the user's whole Dispatch
  history on their own machine.
- Nothing leaves the machine. The scanner reads token counts, timestamps, and model
  names. It does not read message text, and it makes no network call.
- The Recharts dependency adds roughly 100 kb to the web bundle. This is the one
  cost every user pays, whether or not they open the view. The analytics view is
  lazy-loaded with `React.lazy`, so the chart code is not in the initial chunk.

## 11. Testing

Unit, in `packages/core`:

- `readUsage` for Claude Code, against a transcript fixture. Assert dated events,
  not one total.
- `readUsage` for Codex, reusing `structured/codex-frames.fixture.ts`.
- A provider with no `readUsage` yields no rows and marks the thread unknown.
- **Idempotency:** scan the same file twice and assert the totals do not change.
  This is the direct guard against the double-count bug.
- Incremental correctness: scan, append to the fixture, scan again, and assert the
  result equals a full re-parse.
- Truncation: shrink the file and assert the thread rebuilds from zero.
- Day bucketing across midnight and across a timezone offset.

Unit, in `packages/web`:

- The KPI and series derivations.
- The view renders with no data, and with an unknown-usage thread present.

End to end: the isolated-instance pattern — a daemon on a fake `HOME` and port
3999 — so no test ever touches the real `~/.dispatch`.

## 12. Out of scope

- Any export to CSV or to a sheet.
- Per-tool-call or per-skill analytics.
- Folding `agent_runs` into these charts. That dashboard stays as it is.
- Scanning Claude Code sessions that Dispatch did not create.
- Aggregation across machines.

## 13. Risks

| Risk | Response |
|---|---|
| The first scan is slow on a large history | It runs in the background, shows progress, and resumes if interrupted |
| Grok threads have no usage | Shown as "usage not reported", never as 0 |
| The price table goes stale | One shared module, and a test that fails on an unpriced model that Dispatch can spawn |
| Bundle growth from Recharts | The view is lazy-loaded |
| A provider-interface change collides with in-flight provider work | The change is one optional method, additive only |
| Local timezone shifts day boundaries | Bucket in local time, state that in the UI, and test the boundary |
