# Rich Tool Views + Interactive AskUserQuestion — Design

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

In the conversation View, every tool call renders the same generic way: a collapsed `title · detail` line plus an expandable panel with raw Input/Output tabs (`packages/web/src/components/tabs/ConversationView.tsx`, collapsed ~line 478, expanded `ToolCall` ~line 493). That's fine as a fallback but leaves high-value tools hard to read — a databricks SQL query and its result, a file edit, a plan update, a web fetch. Separately, when a Claude thread calls `AskUserQuestion`, the View only shows a generic "use the Terminal" hint; you must switch to the Terminal tab to answer.

We want (a) tailored rendering for the most common tool calls and (b) the ability to **answer an `AskUserQuestion` directly from the View** by clicking options.

## Goals

1. **Rich per-tool rendering** for: SQL/MCP queries, file edits (diff), `TodoWrite` (checklist), and `WebFetch`/`WebSearch` — with the existing generic Input/Output panel as the fallback for every other tool (no regressions).
2. **Interactive `AskUserQuestion`** (Claude threads only): render each question's options as clickable controls and submit the answer to the live thread from the View.

## Verified architecture (grounding facts)

- **ConversationView is live, not a static transcript.** `ConversationView({ terminalId })` (`ConversationView.tsx:22`) resolves the tab and `sessionId` from the tabs store, polls `api.getConversation(terminalId, { since })` every 1–2.5s, reads thread status from `useThreadStatus`, and **already calls `api.sendInput(terminalId, data)`** (`ConversationView.tsx:89`).
- **The web has full tool input + full result text.** The core parser (`packages/core/src/conversation/transcript.ts`) emits, per `tool_use`, `toolName` and `toolInput` = **raw pretty-printed JSON** (`toolInputString`, lines 105–110), and per `tool_result` a `tool-result` item whose `text` is the **full, untruncated** content (`stringifyContent`, line 54 / 112–119). `ConvItem` (web `types.ts`) carries `kind`, `text`, `toolName`, `toolTitle`, `toolDetail`, `toolInput`, `toolFile`, `isError`, `ts`, `uuid`, `line`.
- **Tool↔result pairing already exists.** The render loop (`ConversationView.tsx:335–344`) takes a `tool` item and, if the next item is `tool-result`, passes it as `result` to `ToolCall` and skips it.
- **Sending input to the live PTY** = `POST /api/terminals/:terminalId/input` with `{ data: string }` (`packages/core/src/routes/terminals.ts:80–91`); the web wrapper is `api.sendInput(id, data)` (`packages/web/src/api/client.ts:46`). Sending `\r` already flips the thread to `working` (the route calls `statusService.markWorking` when `data` includes `\r`).
- **`AskUserQuestion` transcript shape** (confirmed from a real Claude JSONL): `tool_use` with `input.questions[]`, each `{ question, header, multiSelect, options: [{ label, description, preview? }] }`. The answer arrives later as a `tool_result` (in a user turn) whose `tool_use_id` matches; its `content` is free-form (it reflects the outcome, not a reliable machine-readable selection).
- **`AskUserQuestion` is Claude-only.** Codex (`statusStrategy: 'pty-timing'`) has no equivalent; its approval prompt is `approval-requested`. Interactive answering applies only to Claude threads. Rich rendering of query/diff/todo/web tools is provider-agnostic.
- **No status hook exists for `AskUserQuestion`** — the status pipeline only sees Claude hook events (`PermissionRequest`, `Notification`). We therefore detect a pending question **from the transcript**, not from status.

## Decisions (from brainstorming)

- **Answer mechanism = A (client-side).** The keystroke mapping lives in a pure web function and is sent via the existing `/input` route. Entirely web; ships live on refresh; **no daemon restart**. (Mechanism B — a core answer endpoint — is a documented follow-up if the client location ever bites; both share the same pure mapping function, so promotion is mechanical.)
- **Rich rendering is additive + fallback-safe.** A registry maps a tool to an optional custom renderer; any unmatched tool keeps today's generic Input/Output panel.
- **Pending detection is transcript-based.** A question is answerable iff its `AskUserQuestion` tool_use is the **last** conversation item and has **no following `tool-result`**. Otherwise it renders read-only.

## Architecture / components

All changes are in `packages/web`. New directory `packages/web/src/components/tabs/toolviews/`.

### Registry

`toolviews/registry.ts` — `getToolView(toolName, toolInput): ToolView | null`.

```ts
interface ToolView {
  /** Optional richer collapsed line; falls back to the generic title·detail line when omitted. */
  collapsed?: (tool: ConvItem) => React.ReactNode;
  /** Optional expanded body; falls back to the generic Input/Output tabs when omitted. */
  expanded?: (tool: ConvItem, result?: ConvItem) => React.ReactNode;
}
```

`ToolCall` (in `ConversationView.tsx`) calls `getToolView` once; if it returns a view with `expanded`, render that in the expanded area; otherwise render the existing tabs. Same for `collapsed`. **Matching is input-shape-driven where possible** (robust across MCP server names) with a small name allowlist for clarity.

### Renderers (each its own file under `toolviews/`)

- **`QueryView.tsx`** — matches when the parsed `toolInput` has a string field named `query`, `sql`, or `statement` (covers `mcp__databricks__databricks_query`, `mcp__intelligems__run_shopifyql_query`, etc.).
  - Collapsed: a database glyph + the first line of the query (truncated).
  - Expanded: the query highlighted as SQL (reuse `highlightCode` / `lib/markdown.ts`), then the result rendered as an HTML table when `result.text` parses as tabular — try in order: (1) `JSON.parse` → array of flat objects → columns = union of keys; (2) a GitHub-style markdown table; (3) TSV/CSV with a header row. If none parse, show the raw result text (current behavior). A hard cap (e.g. 200 rows shown, with a "+N more rows" note) keeps the DOM bounded; the cap is logged in the UI, never silent.
- **`DiffView.tsx`** — matches `Edit`, `MultiEdit`, `Write`.
  - `Edit`: a red/green line diff computed from `old_string` → `new_string` (a simple line-level LCS diff; no external dep).
  - `MultiEdit`: each `edits[]` entry rendered as its own diff hunk in order.
  - `Write`: the new file `content` shown with language inferred from `file_path` (reuse `langFromPath`). The existing "View file" affordance for `toolFile` is preserved.
- **`TodoView.tsx`** — matches `TodoWrite`. Renders `input.todos[]` as a checklist; per item show `content` (or `activeForm` when in progress) with a status glyph: `pending` ○, `in_progress` ◐, `completed` ✓. Completed items get strikethrough/dimmed.
- **`WebView.tsx`** — matches `WebFetch` (`url` + `prompt`) and `WebSearch` (`query`). Collapsed: the URL/host or query. Expanded: the URL/query prominent + the result text as a snippet (markdown-rendered when it looks like markdown, else plain).

### Interactive AskUserQuestion

- **`AskQuestionView.tsx`** — matches `AskUserQuestion`.
  - **Answerable** iff (provider is Claude) AND (this tool item is the last conversation item) AND (no following `tool-result`). The component receives an `answerable` boolean and the `terminalId` (threaded from `ConversationView`, which already knows both: it knows the items array, the tool's index, and the tab's provider).
  - **Rendering:** one card per question — a header chip (`question.header`), the `question` text, and the `options`. Each option shows `label` (bold) + `description`; `preview` shown on expand/hover. Single-select renders radio-style; `multiSelect` renders checkboxes.
  - **Submit behavior:** for a single, single-select question, clicking an option submits immediately. For multiple questions or any multiSelect, the user makes selections and clicks one **Submit** button (disabled until every question has a selection).
  - **Sending the answer:** `buildAnswerInput(questions, selections)` (a pure module, `toolviews/answerInput.ts`) returns the exact keystroke string; `AskQuestionView` calls `api.sendInput(terminalId, keystrokes)`. Selections are recorded optimistically in a tiny local store keyed by the tool's `uuid` so the card immediately reflects the choice; the next poll confirms via the appearing `tool-result`.
  - **Read-only (answered or non-Claude):** render the questions + options without controls. If answered, best-effort highlight the chosen option(s) by matching `result.text`; if no confident match, show options plain with the result text below.
  - **Resilience:** if no `tool-result` for this tool appears within ~6s of submit, surface an **"Answer in Terminal →"** action (focus/select the Terminal tab for this thread). This action is also always available as a small secondary affordance.

### The keystroke mapping (`buildAnswerInput`)

The live prompt is Claude Code's `AskUserQuestion` selection TUI. `buildAnswerInput` encodes selections as keystrokes. The **exact scheme is pinned by a verification spike (plan Task 1)** against a real prompt — either:
- **Arrow scheme:** per question, `\x1b[B` (down) × targetIndex to move the highlight from 0, `\x20` (space) to toggle for multiSelect, `\r` (enter) to confirm/advance; OR
- **Number scheme:** per question, the option's digit then `\r` (more robust — no cursor accounting — if the TUI accepts it).

Whichever the spike confirms, the logic stays entirely inside this pure function so it is unit-testable and swappable. The function assumes each question's highlight resets to the first option when it appears and processes questions in array order; both assumptions are validated by the spike.

## Data flow

Rich rendering: poll → `ConvItem` (with `toolInput` JSON + `result.text`) → `getToolView` → renderer parses input/result → custom DOM (fallback to generic tabs).

Interactive answer: View detects pending `AskUserQuestion` (last item, no result) → user clicks → `buildAnswerInput` → `api.sendInput` (`POST /input`) → PTY TUI receives keystrokes → Claude writes the `tool_result` → next poll shows the answered card.

## Error handling

- Every renderer guards its parse (`toolInput` may be malformed, `result` may be absent/error) and falls back to the generic panel rather than throwing — one bad tool item must never break the conversation render.
- Table/diff/todo parsers degrade to raw text on any parse failure.
- Interactive answer: Codex threads and answered/scrollback questions are read-only. A submit that doesn't produce a `tool-result` within the timeout exposes the Terminal fallback. `api.sendInput` failure surfaces a small inline error and leaves the Terminal fallback.

## Testing

- **Unit (vitest):**
  - `buildAnswerInput` — single-select single question; multi-question sequence; multiSelect toggles → assert exact keystroke strings (per the spike-confirmed scheme).
  - Query result table parser — JSON-rows, markdown-table, TSV inputs → expected columns/rows; non-tabular → raw fallback; row-cap note.
  - Diff builder — added/removed/changed lines for `Edit`; `MultiEdit` multiple hunks.
  - Todo parser — status → glyph mapping.
- **Component (RTL):**
  - QueryView renders a table from a sample result; DiffView shows red/green; TodoView shows the checklist; WebView shows URL + snippet.
  - AskQuestionView: shows controls when `answerable`, calls `api.sendInput` with the expected payload on submit, renders read-only when answered, renders read-only for a Codex thread, and shows the Terminal fallback after the timeout.
  - Registry: an unmatched tool yields the generic panel (no regression).
- **Manual:** in a live Claude thread, trigger a real `AskUserQuestion`, answer it from the View, confirm the thread proceeds and the card flips to answered. Render a real databricks query, a file edit, a TodoWrite, and a WebFetch and eyeball them.

## Out of scope (follow-ups)

- Mechanism B (a core `POST /terminals/:id/answer-question` endpoint owning the keystroke mapping).
- Driving the tab's `needs_input` status from transcript `AskUserQuestion` detection (so the tab badges it).
- Renderers for non-SQL MCP tools (e.g. Acumatica param searches), permission-prompt rendering, and Codex's `approval-requested`.

## Decision

Build it entirely in `packages/web` as an additive, fallback-safe renderer registry plus an interactive `AskUserQuestion` card that answers the live thread through the existing `/input` route. No core changes, no daemon restart; the only brittle surface (keystroke synthesis) is isolated in one tested pure function with a Terminal fallback.
