# Pretty "/" menu and model/effort picker: build plan

Design: `docs/superpowers/specs/2026-11-06-pretty-mode-slash-commands-analysis.md` (options A and B,
decisions, spike results). Built from origin/main at `45bb8759` (v3.25.1).

## Plain-English summary

**What we build.** Two things for Pretty threads, overseers (Control Plane) and Chat:
1. A *picker*. The model name in the status row under the composer becomes a button. It opens a
   small panel with the models and the effort levels. A note says "applies from the next turn".
2. A *"/" menu*. Type `/` at the start of the composer and a list of Dispatch commands opens above
   it: `/model`, `/effort`, `/compact`, `/stop`, `/cli`, `/restart`. On a phone the **+** menu gets
   a "Commands" row that opens the same list.

**How it works.** You pick a model or an effort. Dispatch saves it in the thread, then tells the
running agent: Claude takes it on its input channel, Codex takes it with the next turn. No restart.
A change made during a turn waits for the turn to end. The change lasts for this thread only.
A relaunch, an update or a CLI switch keeps it.

**Impact.** You no longer switch a thread to CLI to run `/model`. Overseers get the same control
(an explicit model beats the coordinator tier). Chat gets one Chat-wide model and effort that
persists. Nothing changes for threads you do not touch. Grok and OpenCode show the model and
effort commands greyed with a reason.

**Risks and rollback.** A typed command must never reach the model by mistake, so Dispatch runs
known commands itself. A message that really starts with a known command word needs a leading space.
An unknown `/word` is sent as text, except in Codex where a hint warns first. A model change misses
the prompt cache once. Rollback: revert the PR; saved `model` and `effort` in a thread's config are
ordinary keys that older builds already read.

**Rollout.** One PR. Gate: type checks and the core and web suites pass; a real-harness check of
Claude and Codex on a scratch port (not done in this PR: see the build record).

**Decisions already made (owner, "go with recs").** A and B together; phase 1 is Claude and Codex;
overseer model freely changeable; Chat-wide setting; unknown `/word` as text (Codex: a hint);
effort is this thread only.

## Units (TDD, one commit per unit)

1. **Command registry** (`core/src/providers/slash-commands.ts`, shared with the web like
   `catalog.ts`). Pure: the command list per surface and harness (thread, overseer, Chat), each with
   a disabled reason where a harness lacks it; `parseSlash(text)` (command, args, or "not a command",
   with the leading-space escape); the effort levels per harness; model and effort validation.
2. **Claude manager** `applySettings`: `set_model` and `apply_flag_settings {effortLevel}` control
   requests with request ids; the reply resolves a promise (error text on a bad model); the reply is
   not shown in the chat. `isTurnOpen`.
3. **Codex manager** `applySettings`: store model and effort on the session; `turn/start` carries
   them (a `turn/steer` does not).
4. **Service + route**: `setThreadSettings` (validate, save the config, apply live, wait for the turn
   to end on Claude, roll back the saved values if the apply fails); `PATCH /terminals/:id/settings`
   (owner only, same guard as the account route). Typed `/model` and `/effort` in a Claude thread are
   caught in `sendThreadMessage` (the control override would mask the CLI's own version).
5. **Chat**: Chat-wide `model` and `effort` in the Chat store; the turn command line uses them;
   `GET` and `PUT /api/endless/settings` (owner only).
6. **Web: picker** (`ModelPicker`), used in the thread status row (through `ContextIndicator`), the
   Control Plane status row and a new Chat status row. API client methods.
7. **Web: "/" menu** (`useSlashMenu` + `SlashMenu`), the **+** "Commands" row, the escape note, the
   Codex hint. Wired into the thread, Control Plane and Chat composers.
8. **Checks**: tsc, core and web suites, a fake-harness check of the manager calls.

## Not in this PR

Grok and OpenCode apply paths (the spikes show the calls work), the native passthrough menu (C),
`/account`, `/context`, `/usage`, `/clear`, `/reload`, an effort reset to default, per-model effort
lists for Codex (a fixed list is offered; Codex answers with an error text if a model refuses one).

## Review round 1 (owner decisions on the Codex and Opus reviews)

- A picked model or effort is saved with a pin (`config.settingsPinned`). The transcript no longer replaces it on the
  next start (restart, `/restart`, `/cli`, update). The pin lets go once a turn has run on the pick, so a later `/model`
  typed in the CLI is followed again. A picked Default keeps its pin until the next pick.
- A pick made mid-turn that is still waiting when the thread exits stays saved and applies at the next start. It is not
  rolled back. Applies run one at a time per thread, and a refused change goes back to what the process last accepted,
  never to a value an earlier refusal rejected.
- A model accepted but an effort refused: the old model is put back on the process; if that fails, the saved model
  follows the process and the error says so.
- Codex efforts depend on the model. The source is the app-server's `model/list` (live-checked: every model has low to
  max; Sol, Terra and Astra also have ultra; Luna stops at max), with a built-in table as the fallback. An unsupported
  effort is refused before it is sent. A model switch drops a saved effort the new model cannot take, and says so.
  The effort is also passed to the Codex CLI (`-c model_reasoning_effort`) and to Pretty on every start.
- A refused change that was rolled back posts a line in the thread (all Pretty surfaces, the Control Plane and the phone)
  and reloads the thread, so the picker shows the real value. Chat shows the refusal as a line above its box.
- `/model` with a bad value keeps the typed text. `/cli` asks first when the thread is working.
- Left for later: a queued message running on the old model, the 15 second control-request timeout split.

## Review round 2

- One lock per thread now wraps validate, save and apply. Concurrent Codex changes are judged one after the other
  against the settings the earlier one left. Codex efforts are checked against the model the thread runs, which for a
  thread with no saved model is the one the app-server bound.
- A thread that stops while a change is being sent is not a refusal. The pick stays saved and applies at the next
  start. The known values are copied when the apply starts, and the process is compared again after the reply.
- A refusal puts a saved value back only if its own request still holds it (a request number, not a value compare).
- When a model switch leaves the saved Codex effort unsupported, the new model's own default effort is sent and saved.
  Live check on codex-cli 0.166: gpt-6-astra at ultra, then gpt-6-luna with no effort, ran at ultra (the thread keeps
  the effort of its last turn). After thread/resume on Luna no effort is recorded and the turn ran at the model default.
  An explicit effort (Luna's default, medium) is accepted.
- An effort-only rollback of an overseer or tier thread restores its tier model, not the CLI default.
- A failed `/cli` shows the daemon's reason, also after the confirmation.
- Claude writes `requestedModel: claude-opus-5-5` (no `[1m]`) after `set_model('opus')`; the pin lets go as designed.

## Review round 3

- A queued pick that is superseded before it runs is dropped field by field: the request number of each setting must
  still be the latest, or it is not sent. Saved and live end on the same value.
- `loadModelEfforts` waits at most 5 seconds (`modelListTimeoutMs`) for the app-server to be ready, then falls back to
  the built-in table, so a silent app-server cannot hold a thread's settings lock.
- The Codex race tests give the first caller the longest wait, so they fail if the lock is removed (checked by removing it).
  The request-number check in `restoreSettings` cannot be reached through `setThreadSettings` any more (the lock and the
  drop above leave no path), so it is tested directly as a second line of defence.
- The "Could not switch" line clears when the thread's mode changes some other way, when the pane shows another thread,
  and has a close button.
- A Codex model switch with no saved effort sends, saves and reports the new model's default effort. The picker marks the
  effort that really runs ("model default") when none is saved. `GET /api/codex/model-efforts` also returns `defaults`.
