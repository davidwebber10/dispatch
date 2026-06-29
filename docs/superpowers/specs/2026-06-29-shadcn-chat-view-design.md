# Structured Chat View (shadcn) — Design Spec

**Date:** 2026-06-29
**Status:** approved-direction (user: "based on shadcn chat interface components … really slick chat based component with good views of various claude and codex outputs")

## Problem

Structured (stream-json) threads work end-to-end on the backend (verified: create → ws → message → live events, e.g. `system/init → assistant → result/success`). The frontend data path also works (verified: sending via the View compose box streams the reply in ~2s). But the feature reads as "broken" because:

1. **Wrong default mode.** `AiThread` defaults every thread to `'expert'` (Terminal/xterm). Structured threads have **no PTY**, so xterm mounts against `undefined` and throws `Cannot read properties of undefined (reading 'dimensions')` — a dead/empty screen. The user must manually switch to View to see anything.
2. **The View isn't "slick."** It's the line-parsed transcript renderer reused from PTY threads; the user wants a first-class chat interface built on shadcn's 2026-06 chat components, with rich rendering of Claude/Codex output types.

## Goals

- Structured threads are **chat-first**: open directly into the chat, never mount xterm, no PTY toggle.
- A **slick shadcn-based chat UI** (`MessageScroller` / `Message` / `Bubble` / `Marker`) rendering Claude (and, when available, Codex) outputs beautifully.
- Rich per-output rendering: assistant **markdown text**, **thinking** (collapsible, shimmer while live), **tool_use** with per-tool rich views (diff, todo, web, query, bash, generic), **tool_result**, **result/usage** footer (cost/tokens), and **user** messages.
- A proper **prompt input** (multi-line, Enter=send / Shift+Enter=newline, send button, attach).
- **Mobile-aware** (one-handed, single column).
- **No regression** to existing PTY thread View, file/notes/browser tabs, or the rest of the app.

## Non-goals

- Codex *structured transport* itself (fast-follow; the chat renderer should be provider-agnostic and ready, but Codex events aren't wired yet).
- The Overseer view (separate effort).
- Replacing the PTY thread's line-parsed View (keep for non-structured threads).

## Approach

### Infrastructure
- Add **Tailwind v4** via `@tailwindcss/vite` + shadcn (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, Radix per component).
- **No global preflight** (import `theme` + `utilities` layers only, skip `preflight`) so the existing hand-rolled CSS (`theme.css`) is untouched. Map shadcn semantic tokens (`--background`, `--foreground`, `--primary`, `--border`, `--card`, `--muted`, `--accent`, `--ring`, radii) onto the existing palette so shadcn components match the dark theme exactly.
- Install chat components: `pnpm dlx shadcn@latest add message-scroller message bubble attachment marker`. Read the installed source to learn the exact API.

### Components (new, under `components/tabs/chat/`)
- **`ChatView.tsx`** — structured-thread chat surface. Consumes the existing `useStructuredStream(terminalId)` adapter (already maps events → `ConvItem[]`). Lays out with `MessageScroller` + `Message`/`Bubble`; renders each item via a **renderer registry**. Owns the prompt input (`api.sendStructuredMessage`). Replaces ConversationView for structured threads only.
- **Renderer registry** (`renderers/`) — one module per output kind, each `({item, result?}) => ReactNode`:
  - `TextMessage` (assistant/user markdown via existing `renderMarkdown`)
  - `Thinking` (collapsible; `shimmer` while streaming)
  - `ToolCallCard` (generic tool_use: name, args, status) + result
  - tool-specific: `DiffTool`, `TodoTool`, `WebTool`, `QueryTool`, `BashTool` (reuse/restyle existing `toolviews/*`)
  - `ResultFooter` (cost, tokens, turns, errors)
  - `Marker` usages for system/init, status changes, "Thinking…", errors.

### Wiring / mode fix
- `AiThread` (TabHost): if `tab.config.transport === 'structured'` → render `ChatView`, force chat-only (no `ModeToggle`, no `TerminalTab`, default mode irrelevant). Never mount xterm for structured threads.
- Keep existing behavior for non-structured AI threads (View/Terminal toggle).
- Robust structured detection helper shared by TabHost + ChatView.

## Test / verification strategy

- **Loop via Playwright on `vite dev` (:5173 → proxy :3456)** — no daemon restart needed; web-only changes hot-reload. Backend untouched, so no session-killing restart until (optionally) a final deploy.
- Each iteration: create a structured thread → confirm it opens directly into chat (no xterm error) → send a message → confirm streamed markdown reply, tool views, thinking, result footer → check desktop **and** mobile (390px) widths → check no console errors → confirm the rest of the app is visually unbroken (Tailwind didn't regress it).
- Clean up spawned test threads each run (delete `config.transport==='structured'` terminals).

## Risks

- **Preflight regressions** → mitigated by skipping preflight; verify the whole app after infra lands.
- **shadcn chat components are 2026-06 (post-knowledge-cutoff)** → install then read their source for the real API rather than guessing.
- **Parallel-tool-call pairing** in the stream (a known deferred issue) → renderer pairs `tool` with the following `tool-result`; handle interleaving defensively.
