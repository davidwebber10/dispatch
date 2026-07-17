# Dispatch — Typewriter Animation for Auto-Named Threads

**Date:** 2026-07-16
**Status:** Design approved; spec awaiting review.

## Goal

When a thread auto-names itself (v2.2.0 feature) while the user is looking
at the sidebar thread list, the new name visibly types itself in:
the default label backspaces away character by character, then the real
name types in with a blinking caret. If the naming happens while the list
isn't being viewed — page not open, project collapsed, different device —
nothing ever animates: a later look just shows the final name.

## Decisions (confirmed)

1. **Style:** backspace-then-type (~25ms/char delete, ~35ms/char type,
   thin blinking caret during; caret disappears at the end; ~1.5s total
   for typical names).
2. **Detection is client-side** — no server changes. The live transition
   `labelSource: 'default' → 'auto'` observed during a tabs refresh IS the
   auto-naming moment; loads and refreshes carry no transition, so replay
   can never animate.
3. **Scope:** sidebar thread rows (ProjectCard, desktop + its mobile
   usage). Tab bar and pinned-threads view do not animate.
4. **Accessibility:** `prefers-reduced-motion: reduce` → instant swap,
   no animation.

## Detection (stores/tabs.ts)

- The web `Terminal` type (`packages/web/src/api/types.ts`) gains
  `labelSource: 'user' | 'default' | 'auto'` (the daemon has sent it since
  v2.2.0; older daemons omit it — treat `undefined` as `'user'`, which
  disables animation, fail-quiet).
- `loadTabs` diffs the store's previous terminals against the incoming
  list per terminal id. When `prev.labelSource === 'default'` and
  `next.labelSource === 'auto'` and the labels differ, it records
  `autoNamed[terminalId] = { from: prev.label, to: next.label, at: now }`
  in the tabs store (plain object map, not persisted anywhere).
- Entries are **consume-once and perishable**: a mounted `ThreadLabel`
  that sees a fresh entry (< 3000ms old) removes it and animates; anything
  older is ignored and pruned on the next `loadTabs`. A collapsed card or
  hidden panel therefore consumes nothing and never animates later.

## Animation (`ThreadLabel` component)

- New `packages/web/src/components/sidebar/ThreadLabel.tsx`, replacing the
  bare `{tab.label}` span in the ProjectCard thread row (same span, same
  styles — `flex: 1`, ellipsis — so row layout cannot jank).
- On mount/update, it checks the store for a fresh `autoNamed` entry for
  its terminal id. If none: renders `tab.label` as plain text (the normal
  path, zero overhead beyond one map lookup).
- If an entry is consumed: phase 1 renders `from` shrinking by one
  character per ~25ms tick; phase 2 renders `to` growing by one character
  per ~35ms tick; a 1-char-wide caret (`▍`-style thin bar via CSS border,
  530ms blink) rides the text end during both phases and unmounts at
  completion. Timers via `setInterval`, cleaned up on unmount; an unmount
  mid-animation simply renders the final label on next mount (store is
  truth; animation is presentation only).
- `window.matchMedia('(prefers-reduced-motion: reduce)')` true → consume
  the entry but render the final label immediately.
- While animating, the displayed text is the animation's; the underlying
  `tab.label` is already final in the store — a concurrent user rename
  mid-animation cancels the animation (effect dependency on `tab.label`)
  and renders the new truth immediately.

## Non-goals

- Animating the top tab bar, pinned-threads view, or overseer chips.
- Animating user renames or any non-auto label change.
- Server-side events or persistence for animation state.
- Replaying missed animations.

## Testing

- Store: transition recorded on default→auto with changed label; NOT
  recorded on first load (no prev), on auto→auto refresh, on user renames
  (default→user), or when labels are equal; entries pruned when stale.
- Component (fake timers): full sequence — "Claude Code" backspaces to
  empty, name types in, caret present during and gone after; consume-once
  (second render doesn't re-animate); reduced-motion instant swap;
  mid-animation label change (user rename) cancels to truth.
- Runtime (isolated daemon + Playwright, reusing the v2.2.0 naming verify
  recipe): seed transcript, trigger naming via hook event with the sidebar
  open, assert the DOM label passes through intermediate lengths before
  settling on the final name; then reload the page and assert NO animation
  (label appears fully formed).
