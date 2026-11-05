# Usage limits: which agents are covered

Dispatch pauses a thread that an agent CLI stopped on a usage limit, shows a red banner, and wakes
the thread after the reset. This page says, for each agent, what the CLI prints and what Dispatch
does with it. "Confirmed" means the text or frame comes from the installed CLI or from a real log.
"Simulated" means the wording is confirmed but the exact screen was not seen on a live stop.

| Agent and surface | Detects a limit | Pauses and auto-resumes | Figures (chip, warning push) |
| --- | --- | --- | --- |
| Claude Code, chat | Confirmed | Yes | Yes |
| Claude Code, terminal | Confirmed | Yes | Yes |
| Codex, chat | Confirmed (error with `usageLimitExceeded`) | Yes | Yes |
| Codex, terminal | Simulated | Yes | Yes (same account figures as Codex chat) |
| Grok, chat | Confirmed | Yes | None |
| Grok, terminal | None | No | None |
| OpenCode, chat | None | No | None |
| OpenCode, terminal | None | No | None |

## Codex terminal

The Codex CLI (0.166.0) holds these messages as strings in its binary:

- "You've hit your usage limit. Upgrade to Plus to continue using Codex (...), or try again at TIME."
- "You've hit your usage limit. Upgrade to Pro (...), visit the usage page to purchase more credits or try again at TIME."
- "You've hit your usage limit for MODEL. Switch to another model now, or try again at TIME."
- "You've hit your usage limit. To get more access now, send a request to your admin or try again at TIME."
- "You've hit your usage limit. Visit the usage page to purchase more credits" (no time).

Dispatch reads these from the terminal screen of a Codex thread only. A banner counts only when it is
one of the CLI sentences above (not prose that starts with the same words), starts its own line, and the
terminal then stays quiet with little text after it. An agent that quotes the text and goes on working
does not pause. Lines the CLI wraps are joined before the reset time is read.
The screen was not captured on a real stop, so this is simulated. The session files of a real stop
also hold a `token_count` event with `rate_limit_reached_type`, which Dispatch does not read.

## Grok chat

On a free-usage stop, `grok agent stdio` sends a `retry_state` update with `type: "exhausted"` and
`is_rate_limited: true`, then `turn_completed` with `stop_reason: "rate_limit"`. Both appear in a real
session file. The message says "Usage resets over a rolling 24-hour window", so there is no clock
time. The thread retries every 30 minutes, up to 5 times. A `retry_state` with `type: "retrying"` is
only a retry and does not pause. Grok reports no account quota figures, so there is no chip entry or
warning push. The red banner and the auto-resume still work.

## Not covered

- Grok terminal: the Grok TUI logs "agent response failed", but its screen text was never captured.
- OpenCode: it passes through the error of whichever provider it uses, so there is no single limit
  message. No limit stop appears in its logs or database on this machine, and `opencode acp` has no
  confirmed limit frame. The `usage.limits` call in the OpenCode API belongs to its HTTP server,
  which Dispatch does not use.

Add a detector for these only after a real stop has been captured.
