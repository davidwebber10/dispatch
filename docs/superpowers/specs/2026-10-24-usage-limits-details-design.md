# Usage limits in the thread Details panel

Date: 2026-10-24. Branch `feat/usage-limits-details`, stacked on PR #106 (`feat/usage-limit-resume`).

## What it shows

Under THREAD DETAILS: Session (5h), Weekly, Weekly (Opus, only if reported), an "As of" line, and
the pause line from #106 ("Paused: session limit, resumes 1:10 AM"). Grok and OpenCode threads
show "Not reported". Numbers only: no sidebar bar, no Chat warnings.

## Data

- Limits belong to the account, so there is one snapshot per provider (app_state key
  `usage_limit_snapshots`, in memory and persisted). Every thread of that provider shows it.
- Each snapshot is tagged with the account that reported it (Claude: `oauthAccount.accountUuid`
  in `.claude.json`; Codex: `tokens.account_id` in `auth.json`). A snapshot from another account
  is never shown as current; the first report from the new account replaces it.
- Claude: the stream-json `rate_limit_event`. Measured with CLI 2.1.309 on 2026-10-24: it is sent
  once per turn (2 turns, 2 events). The plain `allowed` event has a reset time and no
  `utilization`; once the account passes the 90% warning level it also carries `utilization` and
  `unifiedWindows` (five_hour, seven_day, seven_day_opus). Below that level the panel shows
  "Under the warning level, resets ...", not an invented number.
- Codex: `rate_limits` on `token_count` events in the session file, one bounded tail read
  (256 KiB, no widening), at most once per 30 s per thread. Null windows (unlimited plans) show nothing.
- No usage API is polled.

## Not covered

- Claude threads in the CLI (PTY) view do not stream; they show the last figure another Claude
  thread reported, or "Not reported yet".
- Claude utilization below 90% is not reported by the CLI.
- After a restart with no new turn, the figure is the persisted one with its "As of" time.

Retarget this PR to main after #106 merges.
