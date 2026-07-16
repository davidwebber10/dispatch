# New Thread Modal — Design Prompt for Claude Design

**Date:** 2026-07-16
**Purpose:** A self-contained design brief to hand to Claude Design (or the `ui` skill)
to design a brand-new "New Thread" modal for Dispatch. This is a *design* brief — layout,
visual treatment, interaction, and states — not an implementation spec.
**Mockup:** https://claude.ai/code/artifact/61eca0b4-502e-43c4-8502-4f2d854a7ca7

## Context this replaces

Today, clicking the sidebar `+` opens a small dropdown of thread types, then opens a
cramped "New Thread" modal. This redesign collapses all of that into one modal: the `+`
opens the modal directly, and every choice (harness, model, mode, options) happens inside
it. It also merges the two former Claude entries ("Claude Code" and "Claude (structured)")
into a single Claude Code harness with a CLI/Pretty mode toggle.

---

## The prompt (copy-paste into Claude Design)

```
Design a brand-new "New Thread" modal for Dispatch — a dark, terminal-adjacent
developer tool whose left sidebar holds "threads" (AI coding sessions or plain shells).
Today, clicking "+" pops a tiny dropdown of thread types, then opens a cramped modal.
Replace all of that: "+" opens THIS modal directly, and every choice happens inside it.
This is a fast "spin up a thread" action, not a wizard — one compact panel that
reveals/hides sub-sections as the selection changes.

── WHAT THE MODAL MUST LET ME DO, top to bottom ──

1. PICK A HARNESS. Selectable cards, side by side — just a brand logo + name, centered
   (no descriptor line); the selected card gets an accent-green border + soft glow + a
   check badge. Keep each brand logo in its own brand color even when selected (don't tint).
     • Claude Code — Font Awesome "claude" mark, coral #D97757
     • Codex       — Font Awesome "openai" mark, near-white
     • Terminal    — a plain shell (zsh); terminal glyph, neutral. No AI model.
   Only these three for now, BUT lay the grid out so a fourth/fifth card could be added
   later without a redesign. Terminal is a peer card but clearly "just a shell": when
   selected, the mode toggle, model picker, and resume list all disappear — only Name and
   Auto-archive remain.

2. MODE TOGGLE (Claude Code AND Codex; NOT the plain Terminal) — two tiles, "CLI" vs
   "Pretty". CLI = the raw terminal TUI; Pretty = a rich, structured chat UI. DEFAULT to
   CLI. The tiles are smaller/secondary to the harness cards so the hierarchy reads
   "harness first, then mode." Make the switch feel deliberate and nice.

3. PICK A MODEL — harness-specific; the list swaps when the harness changes. Compact
   chips/segmented control, "Default" selected first.
     • Claude Code: Default, Fable, Opus, Sonnet, Haiku
     • Codex: Default, 5.6 Sol, 5.6 Terra, 5.6 Luna
     • Terminal: no model picker at all
   "Default" means "let the harness pick."

4. NAME — optional single-line text field (placeholder "Optional"). Applies to all three.

5. AUTO-ARCHIVE — a toggle whose WHOLE ROW is clickable (switch + the "Auto-archive
   thread" title both toggle it, not just the switch). When ON, reveal an inline duration
   control: a number input + unit dropdown (minutes/hours/days), defaulting to 12 hours,
   with a hint like "archives after this long with no activity." Available for all three.

6. RESUME / RECLAIM A RECENT SESSION — a "Resume recent" list below the primary action,
   for Claude Code and Codex only (not the plain Terminal). Each row: a one-line session
   preview, a relative timestamp, and a message count; clicking a row resumes that session
   instead of starting fresh. Design its loading state (spinner + "Loading recent
   sessions…") and its empty state (hidden). List scrolls internally if long.

7. PRIMARY ACTION — full-width accent-green button, "Start new thread". Design its
   busy/disabled state. Enter submits; Esc closes.

── KEY STATES TO SHOW IN THE MOCKUP ──
   • Claude Code selected → CLI/Pretty toggle (CLI default) + Claude model list + resume.
   • Codex selected → CLI/Pretty toggle + Codex model list (5.6 Sol/Terra/Luna) + resume.
   • Terminal selected → no mode toggle, no model picker, no resume; just Name + Auto-archive.
   • Auto-archive ON (duration control revealed) vs OFF.

── VISUAL LANGUAGE (match the app) ──
   • Dark UI. Modal ~#161619; elevated controls ~#1B1B1E; hairline borders #2C2C32;
     radius 8–12px; inputs ~36px tall.
   • Accent is green #3ECF6A; accent-button text is dark green #08240F. Selected/active
     states use the accent for border/fill + a subtle green glow (0 0 6px rgba(62,207,106,.55)).
   • Primary text #E9E9EC; secondary #8E8E96; tertiary #5A5A61.
   • Section labels are tiny UPPERCASE monospace (JetBrains Mono), wide letter-spacing
     (~600 10px, 1.3px), sitting above each control. Body is IBM Plex Sans.
   • Narrow, single-column, scannable in one glance. Quiet, fast, no heavy chrome.

── CONSTRAINTS ──
   • One panel, no wizard steps; sub-sections appear/disappear based on the harness.
   • Keyboard-friendly and quick — this gets used dozens of times a day.
   • The harness cards and the per-harness model list are the two extensible parts.

Deliver mockups for the states above, including hover/selected treatments. Prioritize a
clean, confident feel for the three harness cards and the CLI/Pretty mode toggle.
```

---

## Decisions baked in (from brainstorming)

- **`+` opens the modal directly** — no more dropdown; the harness is chosen inside.
- **Three harnesses for now:** Claude Code, Codex, Terminal (plain shell). Grid built to
  extend later (research short-listed OpenCode and Pi as the most likely next additions).
- **Two-tile / card selection pattern** for the harness (user preference), with real brand
  logos kept in brand color.
- **CLI/Pretty mode toggle on both Claude Code AND Codex,** default **CLI.** ("CLI" also
  removes the Terminal-harness vs Terminal-mode name clash.) The difference on the wire is
  `config.transport = 'structured'` for Pretty.
- **Model picker is harness-aware;** "Default" = omit `--model` and let the CLI choose.
  Codex models: Default, 5.6 Sol (depth), 5.6 Terra (balanced), 5.6 Luna (fast).
- **Auto-archive: the whole row toggles,** not just the switch.
- **Resume Recent** works for Claude Code and Codex (both support on-disk session resume).

## Open items to confirm before build

- **Codex Pretty mode is new backend work.** The daemon's structured transport is gated to
  `claude-code` today (`packages/core/src/sessions/service.ts:1203`). Enabling Codex Pretty
  means extending that gate to `codex` and teaching the interactive `StructuredSessionManager`
  to spawn/parse Codex's stream-json (already parsed for the runner in `agents/run-stream.ts`).
- **Brand logos.** Mockup uses the official Font Awesome `claude` and `openai` brand marks
  (inline SVG, viewBox 0 0 512 512). The repo currently ships no thread-type logo (colored
  dots only); bring the same two marks in as assets and reuse them as the real thread icons.
