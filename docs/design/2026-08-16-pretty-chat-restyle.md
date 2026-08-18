# Pretty chat restyle — desktop + mobile (from Claude Design)

Source: claude.ai/design project `1876f647-3342-49ab-bad7-5cbaf4a7c97b`
(`Pretty Chat.dc.html` desktop, `Mobile.dc.html` → "Pretty chat — narrow").

Frontend-only. Applies to `ChatView` (all Pretty threads). Use Dispatch tokens
(design green `#3fb950` → `var(--color-accent)`; hairlines → `var(--color-hover)`;
mono → `var(--font-mono)`). Keep all existing behavior (send, attach, dictation,
paging, ask-cards, compacting bar, reconnect state) — this is a re-skin plus a
few new frontend affordances. David will iterate after seeing v1; do what the
design calls for now.

## Header bar (new, at top of ChatView)

44px (54px mobile), hairline bottom border:
- Thread label in mono 12.5px (from tab label) + thin divider + harness/mode
  tag `grok · pretty` (11.5px tertiary; harness = tab type display name).
- Mobile: no divider — label + `grok · pretty` stacked two lines; keep the
  existing mobile back affordance/chrome if ChatView is embedded in a screen
  that already has a header — in that case merge: extend the EXISTING mobile
  thread header with the harness sub-line and the toggle button, don't stack
  two headers.
- Right side: `Hide tool calls` / `Show tool calls` ghost toggle button —
  hides ALL machinery (tool rows/groups) in the timeline. Persist per device
  (localStorage, key `dispatch:chat-show-machinery`, default show).
- Far right (desktop): status dot + mono word — `idle` (green) when not busy,
  `working` (accent, pulse) when busy. Uses existing busy state.

## Timeline (max-width 680 desktop, centered; full-width mobile)

- **User turn**: right-aligned. Meta row above the bubble: mono 9.5px time
  (e.g. `4:12 PM`) + letterspaced accent `YOU`. Bubble: accent background,
  DARK text (`#0c1a10`-equivalent on our accent: keep `#08240F` as used for
  accent-button text today), 16px/500 (15px mobile), radius 8, maxWidth 82%
  (88% mobile). Timestamps: use the item's timestamp when known; live items
  stamp at arrival. Items with no timestamp render the meta row with YOU only.
  (Coordinator-relayed turns keep their "via …" label — place under bubble as
  today.)
- **Turn separator**: 1px hairline between an assistant block and the next
  user turn.
- **Assistant text**: 14.5px (14 mobile), line-height 1.75, primary-secondary
  color (`#d7dbd9` feel). Inline code in md renders as bordered chips (the
  md-view styles already do bg/border — verify size 12px).
- **INSIGHT blocks** (the `InsightText`/insight callouts + thinking?): design
  shows them as left-bordered rows: header `INSIGHT · <dur> · ▸` (mono 9.5
  letterspaced tertiary), body italic 13px dim, clamped to 2 lines, click
  toggles clamp (caret rotates 90°). Apply this to ★ Insight callouts AND
  thinking rows (thinking keeps label THINKING instead of INSIGHT; keeps its
  existing preview-when-collapsed behavior but restyled to match). Duration:
  omit when unknown (no fake numbers).
- **Machinery (tool calls)**: bordered block (hairline top+bottom, no side
  borders), rows 30px:
  - Group row (consecutive same-tool, existing ToolGroup logic): `▸` caret,
    mono tool name, `×N`, ellipsized args summary, right: diff stat when
    derivable from Edit/Write inputs (`+33 −9`, green) and duration when
    known. Expanded: per-call rows indented (file + per-file diff for edits).
  - Single call row: glyph (`$` for Bash, `≡` for Read, `✎` edits, `⌕`
    search, `⚙` other — pick one mono glyph per tool), name, arg summary,
    right meta (lines/duration/status; error red, success green tint).
  - Clicking still opens the existing expanded output view.
  - Mobile: same rows, args ellipsize with `direction:rtl` tail-truncation.
  - All of it hidden when machinery toggle = hide.
- **NEEDS YOU card** (AskUserQuestion pending + `needs_you` StatusNotice):
  coral-tinted card (`rgba(243,113,101,.06)` bg, `#7d4640` border): header
  row dot + letterspaced `NEEDS YOU` + right mono `paused · N questions`.
  Question text 14.5px. For AskUserQuestion: options as buttons (first/
  recommended = accent primary, others ghost) + "or reply below" hint.
  Answering works as today (AskQuestionCard logic, restyled). Multi-select
  questions keep a submit affordance.
- **ANSWERED question card**: BUG FIX — currently only multi-select answers
  show a selected state; single-select answers render unmarked. Answered
  cards must mark every chosen option (accent border/check) for both kinds.
- **DONE card** (`done` StatusNotice): green-tinted card (`#161b17` bg,
  `#24372a` border), dot + `DONE` + right mono meta (tokens · duration ·
  edits when known from the result footer). Summary 14.5px. `blocked` state:
  keep current blue styling but adopt the same card layout.
- **Result footer / errors**: keep, restyle to match (mono meta right).
- Numbered lists in assistant markdown: leave md-view as is (design's `01`
  mono numbers are a nice-to-have; skip in v1).

## Composer (replaces current composer chrome)

Card: `#171a19`-equivalent bg (`var(--color-elevated)`), 1px border (border
brightens when draft non-empty), radius 8, inner padding ~9-11px:
- Textarea row: transparent, 14px, auto-grow (max ~110px desktop / 80 mobile).
- Bottom row: `+` attach button (26px, existing attach/file logic + menu),
  harness chip (mono 11px, shows harness name e.g. `grok`; display-only, no
  dropdown in v1), context meter: 54px × 3px track + fill at percent +
  mono `12% context` (`12%` only on mobile) — reuse ContextIndicator data;
  clicking opens the existing ContextDetailModal. Right: mono hint
  `⏎ send · ⇧⏎ newline` (desktop only) + send button: 28px square, `↑`,
  accent bg when draft non-empty else muted. Keep dictation control in the
  bottom row (left of send) and staged-image chips above the textarea as
  today.
- Drag-drop, paste-image, drafts: unchanged.

## Status / edge states

- WorkingIndicator/ApiRetry/CompactingBar: keep, they already fit the row
  language; move inside the 680 column (already are).
- EmptyState/Reconnecting: keep.

## Files

`packages/web/src/components/tabs/chat/ChatView.tsx` (header, bubbles, turn
meta, separators, composer), `ToolCall.tsx` (row restyle, glyphs, diff stats),
`AskQuestionCard.tsx` (NEEDS YOU + answered-state fix), `StatusNotice.tsx`
(card restyle + meta), `InsightText.tsx` (insight block), `ContextIndicator.tsx`
(compact meter variant for composer). Tests: ChatView.test.tsx +
AskQuestionCard tests must pass; add answered-state regression test.
