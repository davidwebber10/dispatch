# Pretty "/" menu and effort picker: rebuild on 4.3.0

Replaces PR #155 (built on 3.25.1, 291 commits behind main, and it conflicted with the model chip that 4.2.0 shipped).
Design and decisions: `docs/superpowers/specs/2026-11-06-pretty-mode-slash-commands-analysis.md`.

## Plain-English summary

**What we build.** Two things on top of the model chip that 4.2.0 already has under the Pretty composer:
1. An **effort picker**, inside the chip's own card: the Claude levels, or for Codex the levels the thread's model takes.
2. A **"/" menu** above the composer: `/model`, `/effort`, `/compact`, `/stop`, `/cli`, `/restart`. Chat has `/model`, `/effort`
   and `/stop`. An overseer has no `/cli` or `/restart`. On a phone the **+** menu has a **Commands** row.

**How it works.** The chip stays the one model control. `/model opus` makes the same call the chip makes. A bare `/model`
or `/effort` opens the chip's card. A change applies from the next message and keeps the conversation. Effort is per thread
only: it is not saved as a default for new threads. Chat has one model and effort for all of Chat.

**Impact.** Threads you do not touch do not change. Overseers get the same chip and menu, and their model stays free (an
explicit model beats the coordinator tier). Grok and OpenCode keep the chip's model switching; `/effort` is greyed for them.
While a turn runs the chip is off, and typed `/model` and `/effort` fail the same way and keep the text.

**Risks and rollback.** A typed command must not reach the model by mistake: known commands are run by Dispatch, and a
message that starts with a space and then `/model` is sent as text. An unknown `/word` goes to the harness (Codex shows a
hint first). Rollback: revert the PR. `effort` and `effortSetAt` in a thread's config are ordinary keys.

**Decisions already made (owner).** Chip is the one model control; Claude and Codex effort in this phase; Codex efforts vary
by model; overseer model free; Chat-wide setting; unknown `/word` as text; no reset-effort option; refusals are visible.

## What main already did (read first)

`docs/releases/v4.2.0.md`: the chip (`ModelSwitcher`), `POST /terminals/:id/model`, `SessionService.setThreadModel`, manager
`getModel`/`setModel` for all four harnesses, `modelSetAt` so a picked model beats the transcript, the `system/model` frame on
connect, and the "Model switched" line. Nothing of that is duplicated here.

## What this PR adds

| Part | Where |
|---|---|
| Effort route and service | `POST /terminals/:id/effort`, `SessionService.setThreadEffort`, manager `setEffort` (Claude `apply_flag_settings`; Codex: sent with every `turn/start`) |
| Codex efforts by model | `GET /api/codex/model-efforts` (from `model/list`, 5 s limit, built-in table as fallback), `providers/codex-efforts.ts` |
| Model switch on Codex brings the model's default effort | inside `setThreadModel` |
| Overseer may change model (the 4.2.0 route refused every role) | `settingsTarget` allows `coordinator` |
| Chat-wide model and effort | `GET`/`PUT /api/endless/settings`, used by the Chat turn command |
| Typed `/model` and `/effort` guard | `handleTypedSlash` in `POST /terminals/:id/message` |
| Refusal notice in the thread | manager `postNotice` -> `system/settings_refused` -> an error line |
| Codex CLI keeps the effort | `-c model_reasoning_effort` on new and resume |
| "/" menu | `providers/slash-commands.ts` (shared), `composer/slash/*`, `PillComposer` `slash` slot, the + menu Commands row |
| Chip | `ModelChip` (the 4.2.0 card plus an Effort section), used by threads, the Control Plane and Chat |

## Rounds 1 to 3 of #155, one by one

See the PR body for the table (ported, no longer needed because of main, or dropped).

## Not in this PR

Effort for Grok and OpenCode, a reset-effort option, the native passthrough menu, queueing a typed change until the turn ends.

## Review round 4 (owner answers and the two reviews)

Owner answers: a typed `/model` or `/effort` while a turn runs stays refused ("busy", text kept); `/model` now needs owner
proof like `/effort`; other agent threads stay blocked.

- A turn parked on a question (`needs_input`) counts as a turn that runs: the daemon refuses with 409 and the chip is off, for
  threads and for the Control Plane.
- `/restart` asks first when the thread is working, from the menu and from the phone's Commands sheet. Tab only fills in the
  word (or the whole command for a model or effort option) and never runs it; Enter runs.
- Grok and OpenCode `setModel` give up after 15 s (ready and answer), so a silent agent cannot hold the settings lock.
- A Codex `turn/start` that refuses the effort or model: the refused value is dropped, never sent again, the model goes back,
  the thread shows a notice, and the saved pick goes back in the config (the web reloads).
- After the Codex model list loads, the busy and CLI checks run again before anything is applied.
- Chat settings reach a second open device: the daemon announces `endless:settings`, the store takes it, the chip reloads when it
  opens and after a reconnect, and a Chat pick is always sent (a stale chip cannot say "already selected").
- Exit during a change: reproduced (a replacement process already running made the old stop look like a refusal). Fixed with an
  exit watch on the change; the pick is kept.
- Small items fixed: the default effort a Codex switch sends is not saved as a pick; a saved effort with no saved model is kept at
  spawn; the 15 s CLI timeout message says the change may still apply. Not fixed: the CLI can still take a change after the 15 s
  limit while Dispatch has reported it as not answered (the chip may then show a model the config does not have until the next frame).
- Real-turn effort check: not run. A scratch daemon has no Claude sign-in and the daemon has no data-directory setting.

## Review round 5 (the last fix round)

- A Codex `turn/start` rejection is a refusal only when the app-server ANSWERED with an error (`CodexRpcError`) and the session is
  still the current one. A dead app-server, a timeout, or a late answer that reaches an old session no longer drops a saved effort
  or removes a replacement's identical pick.
- A refused model sends the restored model to connected clients (a `system/model` frame without "switched", also kept in the replay
  ring), so the chip shows the model the thread runs again.
- Exit during a change: when a replacement process is already running, the saved pick is now applied to it (and taken back, with a
  notice, if the replacement refuses it). The tests assert the replacement's live value, not only the saved one.
- Chat settings: a generation counter keeps the newest value. An older GET or PUT answer cannot overwrite a newer broadcast, and a
  reconnect reloads the setting even when the history is not at its end.
- Grok and OpenCode: one 15 s deadline covers readiness and the answer, and the timeout says the change may still apply.
- Test gaps closed: the Codex "names neither" test now triggers a real refusal; the Chat tests use delayed answers.

Known gaps (not closed, by design): a refused Codex model with no earlier model on record cannot be restored (the chip keeps the
rejected model until the next frame); the reconcile on a replacement is one attempt; the CLI can still take a change after the 15 s
limit while Dispatch has reported it as not answered.

## Review round 6

- Chat settings: GET ordering and save reconciliation are kept apart. A GET only competes with other GETs and gives way to
  anything that wrote after it was sent (a broadcast or a PUT answer); a GET never makes a successful PUT answer be thrown away.
  A PUT answer is taken unless a broadcast arrived while it was in flight or a later PUT already answered.
- Replacement reconcile: an exit seen while the old request SUCCEEDED now counts as replaced, like a rejected request, so the saved
  pick is applied to the replacement (model and effort), with the same refusal handling.
