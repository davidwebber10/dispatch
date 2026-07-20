# Mobile: modal scrolling, autofocus, and Settings as a rail destination

**Date:** 2026-07-19
**Status:** implemented

Three mobile UI problems, two of which turned out to share a root cause.

## 1. The new-thread modal could not be scrolled

**Symptom:** on a phone, a modal taller than the screen was stuck — the bottom
(including the "Start new thread" button) was unreachable.

**Root cause — not a missing `overflow`.** The shared shell in `common/Modal.tsx`
already had `overflowY:'auto'` on the panel. Two things combined:

1. The panel was clamped to `maxHeight: calc(100dvh - 32px)`. `dvh` does **not**
   shrink for the on-screen keyboard, so with the keyboard up the panel was sized to
   the full viewport while only ~55% of it was visible. There was almost no overflow
   left to scroll even though half the modal sat under the keyboard.
2. The backdrop centred with `align-items:center`, which distributes overflow to both
   sides. A panel taller than the viewport had its top pushed above the scroll origin,
   permanently out of reach.

`index.html` sets `user-scalable=no, maximum-scale=1`, so there was no pinch-to-escape.

**Fix.** Move scrolling to the backdrop and centre the panel with auto margins:

- backdrop: `alignItems:'flex-start'`, `overflowY:'auto'`, `overscrollBehavior:'contain'`,
  padding including `env(safe-area-inset-*)`
- panel: `margin:'auto'`, `flexShrink:0`, and **no** `maxHeight` / `overflowY`

`margin:auto` on a flex child resolves to zero when there is no free space (top-aligned,
fully scrollable) and centres when there is — the requested behaviour in one rule, with
no JS height math. `flexShrink:0` stops the panel being compressed instead of overflowing.

This is the shared shell, so NewThread, NewProject, EditAgent and the Rename modals are
all fixed together.

## 2. Autofocus raised the keyboard on open

`NewThreadModal.tsx` had a bare `autoFocus` on the name input. On a phone this popped the
keyboard the instant the modal opened, which is what pushed the form under the keyboard in
(1) — the same bug, seen from the other end.

**Fix:** `autoFocus={!isMobile}` via the existing `useIsMobile` hook. Desktop keeps the
keyboard-first behaviour; mobile opens quiet.

## 3. Settings: header gear → bottom-rail destination

**Before:** a gear button in the mobile header opened `SettingsModal` — the desktop modal,
rendered on a phone inside a 520px box.

**After:** Settings is a fourth bottom-rail tab presenting an iOS-style drill-down: a list
of sections at level 0, pushing the chosen section onto level 1.

### Architecture

`SettingsModal` welded chrome to content (383 lines; General inline, four sections already
extracted, `ServersSection` module-private). Split into:

| File | Role |
|---|---|
| `settings/ui.tsx` | shared primitives (`Divider`, `Toggle`, `Stepper`, style constants) |
| `settings/GeneralSection.tsx` | General body + the private `ServersSection` |
| `settings/SecretsSection.tsx` | moved out of SettingsModal (SetupWizard imports it) |
| `settings/sections.tsx` | **registry** — `SETTINGS_SECTIONS`: key, label, blurb, icon, Component |
| `settings/MobileSettings.tsx` | `MobileSettingsList` (level 0) + `MobileSettingsSection` (level 1) |
| `settings/SettingsModal.tsx` | desktop chrome only, maps the registry onto its tab strip |

The registry is the single source of truth: adding a section surfaces it on both platforms.
Sections take an optional `onDone` (dismiss surrounding chrome); only General uses it, to
close the desktop modal before opening the setup wizard. Mobile omits it — settings is a
screen, so there is nothing to dismiss.

### Navigation

Settings reuses **level 1** of the existing three-slot slide-rail rather than adding a
parallel nav stack. Drilling in does `history.pushState({ nav: 1, settingsSection: key })`,
so the back button, the popstate handler, and the iOS edge-swipe-back gesture all work
unchanged. `popstate` restores `settingsSection` and re-selects the tab. The header shows
`‹ Settings` with the section name centred; the bottom bar stays visible at level 1, matching
iOS Settings.

### Out of scope (deliberate)

No URL for settings (`/settings/tools`). It would mean touching `parsePath`, and settings is
not something you deep-link into — a reload lands back on Projects.

## Verification

- `tsc --noEmit` clean
- 542 tests pass (86 files), including new coverage for the Modal scroll contract, the
  mobile settings list, and the rail drill-down
- production build clean
