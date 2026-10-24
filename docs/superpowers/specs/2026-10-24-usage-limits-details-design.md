# Usage limits in the thread Details panel

Date: 2026-10-24. Branch `feat/usage-limits-details`, stacked on PR #106 (`feat/usage-limit-resume`).

## What it shows

Under THREAD DETAILS: Session (5h), Weekly, then one row for every other limit the account reports, an "As of" line, and
the pause line from #106 ("Paused: session limit, resumes 1:10 AM"). Grok and OpenCode threads
show "Not reported". Numbers only: no sidebar bar, no Chat warnings.

## Row labels

Rows use Claude Code's own names (CLI 2.1.309 label map), keyed by the event's limit type:
five_hour = Session (5h), seven_day = Weekly, seven_day_opus = Opus, seven_day_sonnet = Sonnet,
seven_day_overage_included = Fable, overage = Usage credit. A row appears only when the account
reports that type; there is no fixed Opus row. An unknown type shows under its raw name, not a guess.
Codex maps its 300-minute window to Session (5h) and its 10080-minute window to Weekly.

## Data

- Limits belong to the account, so there is one snapshot per provider (app_state key
  `usage_limit_snapshots`, in memory and persisted). Every thread of that provider shows it.
- Each snapshot is tagged with the account that reported it (Claude: `oauthAccount.accountUuid`
  in `.claude.json`; Codex: `tokens.account_id` in `auth.json`). A snapshot from another account
  is never shown as current; the first report from the new account replaces it.
- Claude: the stream-json `rate_limit_event`. Measured with CLI 2.1.309 on 2026-10-24: it is sent
  once per turn (2 turns, 2 events). The plain `allowed` event has a reset time and no
  `utilization`; once the account passes the 90% warning level it also carries `utilization` and
  `unifiedWindows` (every limit type the account has). Below that level the panel shows
  "Under the warning level, resets ...", not an invented number.
- Codex: `rate_limits` on `token_count` events in the session file, one bounded tail read
  (256 KiB, no widening), at most once per 30 s per thread. Null windows (unlimited plans) show nothing.
- No usage API is polled.

## Phone and the Context window popup

The phone has no Details pane, so the same section also shows in the Context window popup (tap the
context ring under the composer; the Mac gets it too). It uses the same hook (`useUsageLimits`) and
the same rows and rules as the Details pane (`UsageLimitsRows`, `limitRows`): Session (5h), Weekly,
other types only when reported, raw names for unknown types, the "As of" line, per-account data,
and the pause line. The popup fetches only while open. Checked at 375 px wide: no horizontal
overflow, rows wrap beside their labels.

Known gap: a phone thread in CLI (terminal) mode has no context ring, so it still shows no usage.

## Not covered

- Claude threads in the CLI (PTY) view do not stream; they show the last figure another Claude
  thread reported, or "Not reported yet".
- Claude utilization below 90% is not reported by the CLI.
- Provenance: figures are tagged with the account at the time they are read. Codex figures written
  before its login file last changed are skipped; a report older than the stored one is ignored; an
  unknown account id is an account of its own; a headless box's injected Claude token is the account.
  A Claude process still running across a login switch can report under the old account (not verified).
- After a restart with no new turn, the figure is the persisted one with its "As of" time.

Retarget this PR to main after #106 merges.
