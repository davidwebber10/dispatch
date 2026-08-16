# Settings restyle — Integrations, Secrets, Tools (from Claude Design)

Source: claude.ai/design project `1876f647-3342-49ab-bad7-5cbaf4a7c97b`
(`Integrations.dc.html`, `Secrets.dc.html`, `Tools.dc.html`, `Mobile.dc.html`).

**Scope decision (David, 2026-08-16): pure frontend restyle. NO new backend.**
- No live MCP health probing (rows group by On/Off, not connection state).
- No "Used by" column or usage grouping on Secrets.
- No local-override variables (Doppler-only, as today).
- No tool actions (no Run-install endpoint, no Authenticate, no tools.json editor, no row menus).

Use Dispatch's look and feel (existing `--color-*` and `--font-*` tokens, inline
styles, primitives from `settings/ui.tsx`) — the design's own palette maps:
design green `#3fb950` → `var(--color-accent)`, bg `#121414/#171a19` →
`var(--color-elevated)`/`#1b1b1e` as used today, hairlines `#1e2121` →
`var(--color-hover)`, mono → `var(--font-mono)`. Keep the design's ORGANIZATION
(grouping, tables, chips, letterspaced mono section labels, summary lines).

## Shared patterns (all three pages)

- Section header block: letterspaced mono label (e.g. `INTEGRATIONS`), then a
  description line (12.5px, secondary), then a mono summary line (11px,
  tertiary) like `12 servers · 10 on`.
- Group headers inside lists: small letterspaced mono label + count + hairline
  rule filling the rest of the row + optional right-aligned hint text.
- Rows: hairline top borders (no cards), hover tint `var(--color-hover)`-ish,
  generous but compact padding (~9-11px vertical).
- Filter bar (Secrets, Tools): search input with a mono `/` glyph inside on the
  left; segmented filter buttons in one bordered rounded group, active segment
  filled; right-aligned mono summary.
- Empty filter result: centered "No X match <query>".

## Integrations (desktop)

- Header row: `INTEGRATIONS` label + spacer + Export / Import ghost buttons
  (existing handlers). Description as today. Summary line: `N servers · M on`.
- Rows grouped: `ACTIVE` (enabled, accent-tinted label) then `OFF` (disabled,
  tertiary label), each with count. Only render non-empty groups.
- Row: name (13px, 500; dimmed when off) + transport chip (`REMOTE`/`LOCAL`
  mono 9.5px bordered chip — map from type remote/stdio) — second line: url or
  `command args` (mono 11.5px tertiary, ellipsized). Right: On/Off button
  (mono 11px; when on: accent-tinted bg/border/text like the design's
  `#1c2f22/#2f5c3c/#8bc994` feel via accent color-mix or fixed tints) and a ×
  remove button (26px square, red hover).
- ADD A SERVER section under a hairline: mono letterspaced label, then
  name input (flex 0 1 300px) + url input (flex 1) + green Add button in one
  row; headers textarea below; `Advanced: add a local command` link stays,
  switching to command/args/env exactly as today (functionally unchanged).

## Secrets (desktop)

- Header block: `SECRETS (DOPPLER)` + description. Right side, same row:
  connected chip (green dot + mono `project / config`), `Re-sync` ghost button
  (refetch list; label flips to `Synced ✓` for ~1.5s), `Disconnect` ghost
  button (existing handler + confirm as today if present).
- Read-only toggle row (label "Read-only" + hint line + existing `Toggle`
  primitive) between hairlines. Hint: read-only → "Values come from Doppler;
  nothing on this daemon can change them." else "Edits allowed — changes write
  to Doppler." Wire to existing `setDopplerConnection` readOnly flag IF the
  current UI already persists it without re-entering the token; otherwise keep
  the current read-only control's behavior, restyled.
- Filter bar: search (`Filter variables`) + `Reveal all values` / `Hide all
  values` ghost toggle + right mono summary `N variables`. (No
  referenced/unused filters — cut with the Used-by decision.)
- Table: grid `minmax(260px,1.25fr) minmax(150px,1fr) 92px` — columns Name /
  Value / actions. Mono column headers (9.5px letterspaced) under a hairline.
- Row: mono name (ellipsized); value masked as `••••••••••••` (tertiary,
  letterspaced) until revealed (then mono, secondary); actions right-aligned:
  reveal (eye; accent when open), copy (⧉ → ✓ accent flash ~1.2s), delete
  (⌫, red hover; hidden when read-only).
- Add variable (hidden when read-only): mono label, NAME input (0 1 330px,
  uppercase) + value input (flex 1) + green Add.
- When read-only: green-tinted banner card at the bottom: mono `read-only` +
  "Values sync from Doppler. Turn off read-only to add, edit, or delete
  variables."
- Keep existing connect flow (token/project/config) for the disconnected
  state, restyled to match.

## Tools (desktop)

- Header block: `TOOLS (CLI)` label + description with inline-code chips for
  `~/.dispatch/tools.json` and `dispatch tools install` (styled code chips,
  NOT buttons — no actions). No buttons on the right.
- Filter bar: search + segmented All / Ready / Needs auth (counts) + right
  summary `N tools · M need auth`.
- Table: grid `minmax(230px,1.2fr) 130px 160px minmax(120px,0.5fr)` — Tool /
  Kind / Status / (right: docs link).
- Groups: `Needs auth` (red-tinted label, hint "Installed, but the agent
  cannot use them yet") then `Ready` (green label, hint "Available in every
  thread"), from existing `installed`/`authed` fields. Not-installed tools:
  group under `Needs auth`? No — add a third group `Missing` (tertiary) if any
  tool has installed=false, hint "Not found on PATH".
- Row: mono tool name + kind chip (`BINARY`/`NPM`/`SCRIPT` from kind) +
  description line under (11.5px secondary); Status cell: 6px dot + mono text
  — ready: green dot `installed · authed`; needs auth: red dot `needs auth`;
  missing: gray dot `not installed`. Right: `docs` link when `docs` present.
- Footer line: "Tools run with your shell environment." (plain text; no link
  since Secrets nav from inside settings differs per shell — optional: switch
  the settings section to Secrets via the existing section-switch mechanism.)

## Mobile (all three, in MobileSettings screens)

Follow `Mobile.dc.html`: same content reorganized for narrow width.
- Keep the existing mobile settings chrome (back + centered title).
- Integrations: summary line, Export/Import row, grouped rows (state dot +
  name + chip, url line, On + × on the right), full-width green `Add server`
  button at the end that opens a BOTTOM SHEET (dark scrim, sheet slides from
  bottom, radius top corners) containing the same add form (remote/local
  segmented at top, name/url/headers or command/args/env, Add + Cancel).
- Secrets: chip + Re-sync/Disconnect row, read-only toggle row, search +
  reveal-all row, two-line rows (name; value + actions), full-width
  `Add variable` button opening the same style of bottom sheet (hidden when
  read-only).
- Tools: search row, grouped two-line rows (name + kind chip + status dot line,
  desc line, docs link).
- The sheet pattern: `position:fixed; inset:0; z-index high; rgba scrim;
  justify-content:flex-end`, sheet `background: var(--color-elevated);
  border-radius: 14px 14px 0 0; padding + safe-area bottom`.

## Files

- `packages/web/src/components/settings/IntegrationsSection.tsx` — restyle.
- `packages/web/src/components/settings/SecretsSection.tsx` — restyle.
- `packages/web/src/components/settings/ToolsSection.tsx` — restyle.
- `packages/web/src/components/settings/ui.tsx` — add shared bits if needed
  (group header, filter segment, search input, sheet) rather than duplicating.
- Mobile: sections are shared components rendered by `MobileSettings.tsx` —
  make each section responsive via `useIsMobile()` (bottom-sheet add flows on
  mobile, inline forms on desktop) instead of forking components.
- Existing tests must pass; extend `ToolsSection.test.tsx` and modal tests if
  they assert on markup that changes. NO api/client.ts changes.
