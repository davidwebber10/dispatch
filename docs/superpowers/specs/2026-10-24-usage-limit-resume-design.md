# Usage-limit auto-resume — design note

Date: 2026-10-24. Branch: `feat/usage-limit-resume`. Status: built, draft PR.

## Problem

On 2026-10-24 a Claude thread stopped at about 1 AM with "You've hit your session limit ·
resets 1:10am (America/Indianapolis)". Nothing woke it. It sat idle for about 7 hours until the
owner typed "continue". A weekly limit has the same effect, but the wait can be days.

## What the daemon does now

1. **Detect.** The CLI's own limit signal is read at the turn boundary (no text scraping of
   normal prose).
   - Claude Code (Pretty): the error `result`, the synthetic assistant frame (`apiError:
     usage_limit_reached`, `quotaLimits.resetsAt`, `rateLimitType`), or a `rate_limit_event`
     with status `rejected`. The structured reset time (epoch seconds) wins; the text
     "resets 1:10am (America/Indianapolis)" is the fallback.
   - Codex (Pretty): the `error` notification with `codexErrorInfo` = `usageLimitExceeded` or
     `rateLimitExceeded`, plus the message text ("try again at ..." / "try again in 2 hours").
   - CLI (PTY) threads: the terminal output is scanned for the exact Claude banner shape, and a
     match counts only if the terminal is quiet 5 seconds later (an agent that merely quotes the
     text keeps working, so it never parks).
   - Kind: `session` (5-hour window), `weekly` (7-day window, including the per-model weekly
     limit), `usage` (any other usage or rate limit, such as Codex). The kind shows in the label.
2. **Park.** One row per thread in `usage_limit_parks` (survives restarts): kind, provider,
   reset time, raw message, attempts, whether the reset time was parsed. The thread shows the
   existing dormant state ("scheduled") with the label `Paused: session limit, resumes 1:10 AM`
   (weekly: `Paused: weekly limit, resumes Mon 9:00 AM`). It is not shown as an error.
3. **Wake.** One timer for the whole daemon ticks every 30 seconds. It never sleeps in a long
   timer, so a weekly pause survives restarts and nothing retries in between. A parked thread
   wakes at reset + 90 seconds. Wakes for the same provider are 20 seconds apart. The thread
   gets: "Your usage limit has reset. Continue where you left off."
4. **Re-park and cap.** If the thread hits the limit again, it parks again with the new time.
   After 5 wakes with no finished turn in between, the daemon stops and tells Chat.
5. **Guards.** No wake if the thread is archived or deleted, the owner sent it a message or
   typed in it after the stop (the park is dropped), the owner stopped it, or it is already
   working (the park is dropped).
6. **Chat.** One note when a chain of pauses starts, one line per auto-resume, one note when the
   cap is reached (this one wakes Chat). Re-parks do not post.

## Design calls

- Reuse the `scheduled` thread state for the label. No new UI state; the label rides on the
  existing activity text. A new table (not `agent_schedules`) because that table is a
  recurring-run definition with a project foreign key, not a one-shot wake of an existing thread.
- Unparsed reset time: fallback retry 30 minutes for session/usage, 6 hours for weekly. The label
  and the Chat note say "reset time unknown, retrying in 30 minutes".
- Time zone: the zone in the CLI text is used (Intl, no new dependency). A time-only text said
  after that time means the next day; "Mon 9am" means the next Monday.
- Grok and OpenCode: no limit signal is known. Gap, not guessed (see below).

## Not covered

- Grok and OpenCode threads (no documented limit signal; a limit shows as a normal error).
- Claude `overage` / credit-purchase prompts, and API-key (non-subscription) 429 rate limits that
  clear in seconds (the CLI retries those itself).
- PTY threads for Codex/Grok (only the Claude banner shape is scanned).
- A thread whose process was killed while paused wakes by reviving it (same path as a message).
- Account scope: parks are per thread. Wakes stagger per provider, not per account (Dispatch does
  not know which login a thread used).

## Owner decisions (build uses the recommendation)

1. Wake buffer after the reset: 90 s. Recommend keep.
2. Retry cap: 5. Recommend keep.
3. Wake text is fixed. Recommend keep.

## Expected conflicts with draft PR #104

#104 also edits `structured/manager.ts` (result handler) and `sessions/service.ts`. This branch
touches the `is_error` branch of the Claude `result` handler (about 6 lines), one `failed` case
in `codex-manager.ts`, and adds hooks at the top of `sendStructuredMessage`, `stop`,
`stopTerminal` and `archive`. Resolve by keeping both sides.
