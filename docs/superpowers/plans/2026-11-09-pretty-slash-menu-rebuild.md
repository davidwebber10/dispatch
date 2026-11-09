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
| Overseer may change model (David's route refused every role) | `settingsTarget` allows `coordinator` |
| Chat-wide model and effort | `GET`/`PUT /api/endless/settings`, used by the Chat turn command |
| Typed `/model` and `/effort` guard | `handleTypedSlash` in `POST /terminals/:id/message` |
| Refusal notice in the thread | manager `postNotice` -> `system/settings_refused` -> an error line |
| Codex CLI keeps the effort | `-c model_reasoning_effort` on new and resume |
| "/" menu | `providers/slash-commands.ts` (shared), `composer/slash/*`, `PillComposer` `slash` slot, the + menu Commands row |
| Chip | `ModelChip` (David's card plus an Effort section), used by threads, the Control Plane and Chat |

## Rounds 1 to 3 of #155, one by one

See the PR body for the table (ported, no longer needed because of main, or dropped).

## Not in this PR

Effort for Grok and OpenCode, a reset-effort option, the native passthrough menu, queueing a typed change until the turn ends.
