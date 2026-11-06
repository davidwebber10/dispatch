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

## Known limits

- **The Codex terminal screen is simulated, not captured.** The wording is confirmed from the binary,
  but the TUI was never seen on a real stop. If the TUI draws the message with cursor moves instead of
  printed text, the stripped screen can lose the spaces and the stop is missed. Only the CLI error mark
  before the message, or no mark, is accepted; a message after "> ", "- ", a bullet or a code fence is
  treated as a quote.
- **Grok keeps a limit it saw after a normal turn end.** If a `retry_state` `exhausted` frame arrives
  and the turn then ends with a normal `end_turn`, the stored limit stays set until the next turn
  boundary (`grok-translate.ts`, `pendingLimit`). A rate-limited turn ends with `stop_reason: "rate_limit"`
  in every captured stop, so this was not seen to happen, and it was left as is.
- **Fenced blocks:** limit text is a quote only when it sits between an opening fence and a matching
  closing fence that comes after it (three or more backticks or tildes at the start of a line; the
  closing fence uses the same character, is at least as long, and has nothing after it). A fence that
  never closes in the window (a collapsed tool preview cut the block), a closing fence whose opener
  scrolled out of the window, and a fence line the CLI prefixes with a gutter mark quote nothing.
- **A Codex terminal turn that hits the limit again also reports "turn complete".** Codex writes a
  `task_complete` event with the limit error for such a turn. The service remembers the retry chain
  for 2 minutes after a woken thread's turn-complete signal, so the stop read a few seconds later
  continues the attempt count (5 wakes, then it stops) instead of restarting at zero.
- **Another Codex wording is not detected:** a real session file holds a workspace spend cap stop
  ("You hit your spend cap set by the owner of your workspace ..."), which the terminal reader does
  not match. Codex chat reads it from the error code.
- **A wake that redraws the screen can park a thread again.** If the resumed CLI repaints the old
  banner from its scrollback right after the wake, the watcher can read it as a new stop. Left for a
  later change.
- **A repeat stop right after a wake** is seen: a wake clears the terminal watcher's memory of the
  thread, and the service keeps the attempt count (5 wakes without a finished turn, then it stops).

## Not covered

- Grok terminal: the Grok TUI logs "agent response failed", but its screen text was never captured.
- OpenCode: it passes through the error of whichever provider it uses, so there is no single limit
  message. No limit stop appears in its logs or database on this machine, and `opencode acp` has no
  confirmed limit frame. The `usage.limits` call in the OpenCode API belongs to its HTTP server,
  which Dispatch does not use.

Add a detector for these only after a real stop has been captured.
