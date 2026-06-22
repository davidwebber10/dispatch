# Visual mode: interactive prompts (never-stuck)

**Date:** 2026-06-22
**Status:** Approved design — ready for implementation plan

## Problem

Visual mode (the chat-style thread view, currently labelled "Pretty") renders the
parsed transcript jsonl, which only contains `user | assistant | thinking | tool |
tool-result`. It is **blind to interactive prompts** the agent throws up in the
terminal — these are ephemeral ANSI/TUI screens, not transcript entries:

- **Startup prompts** when a thread (re)launches: "resume from summary or full?",
  "trust the files in this folder?", theme/login.
- **In-turn prompts**: the model asking a multiple-choice question, an approval,
  a confirm `(y/n)`, or a multi-step series of questions.

Today, opening Visual mode while the underlying PTY sits at one of these screens
shows nothing actionable — the thread looks idle but is actually blocked, and the
user is stuck unless they switch to the terminal.

## Goal

Make Visual mode **never-stuck**: it stays a clean chat view, but surfaces *any*
prompt the terminal throws as a one-tap control, with a real-terminal fallback for
anything we can't parse. Nothing is auto-decided for the user — every prompt
(including boilerplate) is surfaced. Scope this round: **Claude and Codex**.

Also: **rename the mode "Pretty" → "Visual"** (display only).

### Decisions (from brainstorming)

- **Never-stuck chat UI**, not a literal terminal mirror.
- **Surface every prompt** as a one-tap choice; do *not* auto-answer boilerplate.
- **Both providers** (Claude + Codex) this round.
- Approach **A**: PTY-screen detection + provider parsers + inline-terminal fallback.
  (Rejected: B — structured SDK/stream-json protocol, too large and fights the
  interactive-REPL + dual-mode architecture; C — terminal-only, loses the one-tap
  widgets the user wants. C survives as A's built-in fallback.)

## Architecture & data flow

```
PTY output ──► TerminalMonitor (existing idle/busy timing)
                   │  on "went quiet"
                   ▼
            PromptService.check(terminalId)
                   │  reads ptyManager.getBuffer(id) → strips ANSI → current screen
                   ▼
            detectPrompt(provider, screen)        ← PURE, fixture-tested
                   │  DetectedPrompt | null
                   ▼
            dedupe + broadcast  terminal:prompt {terminalId, prompt|null}
                   ▼  (websocket)
            web stores/prompts.ts  →  ConversationView renders PromptCard
                   │  user taps an option
                   ▼
            POST /api/terminals/:id/input { data: option.keys }   (existing endpoint)
                   ▼  PTY advances → screen changes → detector clears the prompt
```

Detection runs whether or not Visual mode is open, so (a) a prompt that appeared
before the user opened Visual mode is already waiting, and (b) it sharpens the
sidebar `needs_input` dot for free.

### New backend units (cleanly split)

- **`packages/core/src/status/prompt.ts`** — PURE `detectPrompt(provider, screen):
  DetectedPrompt | null`. ANSI-stripping + all provider parsers live here. No I/O →
  unit-testable against captured fixtures.
- **`packages/core/src/status/prompt-service.ts`** — `PromptService`: triggered when
  a PTY goes quiet, reads `ptyManager.getBuffer(id)`, calls `detectPrompt`, dedupes
  (don't re-broadcast an unchanged prompt), and broadcasts `terminal:prompt` (or
  `null` to clear when the screen advances). Constructed + wired in `server.ts`
  mirroring `StatusService`.

### Normalized model (provider-agnostic — the web never sees Claude/Codex specifics)

```ts
interface PromptOption { label: string; keys: string; }  // keys to send to choose it
interface DetectedPrompt {
  kind: string;            // 'trust-folder' | 'resume-picker' | 'select' | 'confirm' | 'permission' | 'unknown'
  question: string;        // human-readable title
  options: PromptOption[]; // [] when choices couldn't be parsed
  parsed: boolean;         // false → web shows the inline-terminal fallback
  raw?: string;            // screen excerpt (fallback display / debugging)
}
```

## Detection, parsing & keystroke mapping

**Prompt vs idle.** "Quiet" alone is insufficient (a bare REPL is also quiet).
`detectPrompt` returns non-null *only* when the screen matches a prompt signature:
a selection cursor (`❯`), a numbered option list, a `(y/n)`, or a known boxed
question frame. The empty input box must not match.

**Parsers** — small `(screen) → DetectedPrompt | null` functions, one per shape,
per provider; `detectPrompt` tries them in order and returns the first hit.

| kind | Claude shape | options → keys |
|---|---|---|
| `trust-folder` | "Do you trust the files in this folder?" | Yes/No → menu keys |
| `resume-picker` | resume-from summary/full list | listed choices |
| `select` | boxed question + `❯` numbered list | each item → its number (or arrow-nav) |
| `confirm` | `(y/n)` | Yes→`y`, No→`n` |
| `permission` | "Do you want to proceed?" 1/2/3 | numbered options |

Codex gets its own parser set for its TUI framing, emitting the same normalized
model. **Capture real fixtures first** (trigger each prompt, snapshot the buffer);
parsers are written against ground truth and the fixtures become regression tests.

**Keystroke mapping (the fragile bit).** Numbered menus: send the digit (+ `\r`
where required). Arrow-only menus: compute arrow count from the highlighted index
to the target, then `\r`. Chosen per-parser from the captured fixture. Most likely
point of breakage across CLI versions — mitigated by the fallback below.

**Two-layer safety net (makes "fragile" acceptable):**
1. Screen looks like a prompt (`❯` / `(y/n)` / box frame) but **no parser matches**
   → emit `{ parsed: false, raw: screen }` → web shows the **inline terminal
   fallback**; user answers manually, never stuck.
2. Every parsed card also has a small **"Answer in terminal"** escape hatch, so even
   a wrong keystroke mapping is recoverable without leaving Visual mode.

A broken/unknown parser therefore degrades to "answer manually," never to "stuck."

## Web rendering

- **`packages/web/src/stores/prompts.ts`** — `byTerminal[terminalId]: DetectedPrompt
  | null`, fed by `terminal:prompt` events (registered in `App.tsx` alongside the
  other stores).
- **`ConversationView`** renders a **`PromptCard`** pinned just above the composer
  when a prompt is active for the open terminal:

```
┌─ Claude is asking ───────────────────────────┐   parsed: true
│ Do you trust the files in this folder?          │
│   [ Yes, proceed ]   [ No ]    ⌗ Answer in terminal │
└──────────────────────────────────────────────┘

┌─ Claude is asking (answer below) ─────────────┐   parsed: false
│  ▓▓ inline live terminal (the real PTY) ▓▓      │   (reuses TerminalTab, ~8 rows)
└──────────────────────────────────────────────┘
```

- **parsed** → question + option buttons. Tap → `api.sendInput(id, option.keys)` →
  optimistic clear; detector confirms the clear when the screen advances.
- **unparsed** → inline embedded terminal (reuse `TerminalTab`, a few rows).
- **Multi-step questions** work naturally: as the agent advances, the detector
  clears the old prompt and broadcasts the next; the card swaps; the user answers
  one card at a time.

**Rename.** `Pretty → Visual` — toggle label in `TabHost.tsx`, the empty-state copy
in `ConversationView.tsx`, and comments. Internal mode key stays `normal`
(display-only change).

## Edge cases & error handling

- Screen advances / output resumes → broadcast `null`; card disappears.
- User answers in Terminal mode directly → same PTY advances → card clears.
- Wrong keystroke → still blocked → card stays (or fallback) → never stuck.
- Detection flap → debounce + dedupe by `kind + question`; broadcast only on change.
- Thread exits → clear any prompt for it.

## Testing

- **`detectPrompt`** — fixture tests, one per known prompt shape per provider (the
  bulk of the work; written TDD against captured screens).
- **`PromptService`** — dedupe + clear-on-advance behavior.
- **Web** — `prompts` store test; `PromptCard` renders option buttons (parsed) vs
  the inline terminal (unparsed).

## Build order

1. Capture real prompt fixtures (Claude + Codex: trust-folder, resume-picker,
   select, confirm; permission if reachable).
2. `detectPrompt` + parsers (TDD against fixtures).
3. `PromptService` + server wiring + `terminal:prompt` event.
4. Web `prompts` store + `PromptCard` + inline-terminal fallback + `App.tsx` wiring.
5. Rename Pretty → Visual.
6. Build + test; deploy mini → MacBook (MacBook restart ends the session).

## Out of scope

- Replacing the interactive REPL with a structured protocol (Approach B).
- Auto-answering boilerplate prompts (explicitly rejected — surface everything).
- Rendering arbitrary full-screen TUIs (e.g. an editor) as widgets — those hit the
  inline-terminal fallback.
