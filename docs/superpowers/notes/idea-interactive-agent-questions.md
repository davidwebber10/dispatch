# Idea — interactive agent AskUserQuestion in Dispatch's UI

When a CLI thread running INSIDE Dispatch (Claude Code / Codex) calls its own
`AskUserQuestion`-style tool, Dispatch's conversation view already renders the
tool call ("pretty mode"). Make those questions INTERACTIVE: render the options
as clickable buttons in the Dispatch UI; clicking one sends the answer back into
the thread's input (via the existing input/sendInput path) so the agent receives
it. Support multi-question prompts.

Status: captured 2026-06-26, pending brainstorming. Queued AFTER the mobile-push
feature unless the user reprioritizes.

Open questions for the brainstorm:
- How to reliably detect an AskUserQuestion tool-call in the live transcript/stream
  (Claude vs Codex shapes) and know it's still pending (not already answered).
- How clicking maps to input: the exact text/keystrokes to inject so the CLI
  registers the selection (option index? the option label? the tool's expected
  response format).
- Multi-question rendering + partial answers.
- Mobile (pretty mode is the main mobile surface).
