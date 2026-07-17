# Per-thread alerts (bell) — design

**Date:** 2026-07-16
**Status:** Approved (brainstorm complete)
**Branch:** `worktree-thread-alerts`

## Problem

Dispatch already pushes a web notification when *any* thread settles, behind a single
global Settings toggle ("Notify when a thread finishes"). That is all-or-nothing.
The user wants to arm alerts on *specific* threads — a bell icon next to the thread
name — and get a push notification (phone PWA) or system notification (desktop
browser) when **that** thread resolves: it stopped to ask a question, or it finished
working and is now waiting. Tapping the notification must land directly in that
thread's terminal view.

## Decisions (from brainstorm)

1. **The bell replaces the global toggle.** The "Notify when a thread finishes"
   setting is retired. Settings keeps only the per-device "enable push
   notifications" enrollment toggle. Alerts fire solely for threads whose bell is on.
2. **The bell is sticky.** It stays on until manually turned off; a thread that asks
   three questions alerts three times.
3. **Suppression rule: "notify unless viewing it."** A device is skipped only when
   it is present (app focused) *and* its active tab is the resolving thread's
   terminal. Away devices and devices viewing anything else are notified.
4. **Toggle surfaces:** thread context menu item + bell button in the open thread's
   terminal header. The bell next to the thread name in the sidebar is a
   display-only indicator.
5. **Notification copy is template-based, never model content.**
   Title = thread label; body = `Is asking a question` (needs_input) or
   `Completed its task` (settled to waiting/idle).
6. **Capability-based visibility.** In a context that cannot receive web push
   (e.g. iOS Safari in-browser, insecure origin), all alert UI is hidden — no row
   bell, no menu item, no header button. Consequence (accepted): the flag is
   thread-level, so an incapable browser shows no bell even for a thread armed from
   the phone; the phone still receives pushes.
7. **Architecture: thread flag + server-side gate** (Approach 1). Per-device
   filtering on the client was rejected because iOS requires every received push to
   display a notification, so filtering must happen before send.

## Requirements

- Bell indicator next to the thread name in the sidebar when alerts are enabled,
  on mobile and desktop.
- Toggle from the thread context menu and from the open thread's terminal header.
- Push notification to every eligible device when a bell-enabled thread transitions
  `working → needs_input` or `working → waiting/idle`.
- Tapping the notification focuses/opens the app and activates that thread's
  terminal tab.
- Alert UI only appears for agent threads (`claude-code`, `codex`) — shell
  terminals never resolve and get no bell UI.
- Alert UI only appears in push-capable contexts.
- Toggling the bell on from a capable but not-yet-enrolled device runs the push
  enrollment flow inline (permission prompt + subscription). On denial, the toggle
  reverts with a brief hint.

## Architecture

A thread's alert flag lives in its existing `config` JSON blob
(`terminals.config.alertsEnabled: boolean`, absent = off) — same pattern as
`pinned`, `autoArchive`, `transport`. No schema migration. The notify decision is
made server-side at the existing settled hook.

### Server (packages/core)

- **Gate** — `StatusService` fires `threadSettledHook` exactly on
  `working → waiting/needs_input` (`src/status/service.ts:96-110`). The hook
  registrations (`src/server.ts:186-193` and `:312-319`) currently always call
  `pushService.notifyThread(...)`. Change: load the terminal and skip unless
  `config.alertsEnabled === true`.
- **Copy** — hook builds title = thread label, body = `Is asking a question` |
  `Completed its task`. Payload keeps `terminalId` (already present,
  `src/push/service.ts:51`); add notification `tag = terminalId` so a newer alert
  from the same thread replaces the older one.
- **Toggle endpoint** — `POST /api/terminals/:terminalId/alerts { enabled: boolean }`
  in `src/routes/terminals.ts`, modeled on the auto-archive route (`:296-311`),
  which merges into `config` server-side. The generic terminal PATCH (`:288`)
  replaces the whole config blob and is unsafe for concurrent multi-device writes —
  do not use it for this.
- **Presence rule** — `POST /api/push/presence` (`src/routes/push.ts`) gains
  `activeTerminalId?: string | null` (null = app blurred/hidden).
  `PushService.setPresence` stores it alongside the timestamp. `notifyThread`
  currently sends only to away devices (`src/push/service.ts:42-54`); new rule:
  **send unless** the device is present *and* `activeTerminalId === terminalId`.
- **Failure handling** — unchanged: 404/410 endpoints pruned; send errors logged
  and never block the `terminal:status` broadcast.

### Web (packages/web)

- **Store action** — `setAlertsEnabled(terminalId, enabled)` in `src/stores/tabs.ts`,
  shaped like `setPinned` (`:107`) but calling the dedicated merge endpoint via a
  new `api/client.ts` method. Local config state updates optimistically; revert on
  error.
- **Bell indicator** — in `ThreadRow`
  (`src/components/sidebar/ProjectCard.tsx:128-131`), next to the label, mirroring
  the pinned icon. Display-only. Rendered only when the thread is an agent type and
  `canReceiveAlerts()` is true.
- **Context menu** — "Alerts on/off" item in the thread menu
  (`ProjectCard.tsx:442-469`).
- **Terminal header** — bell toggle button in the open thread's view, placed in
  the existing header/toolbar row that `TerminalTab`/`TabHost` renders
  (`src/components/tabs/`), alongside the current per-tab controls; shows filled
  vs outline bell for on/off.
- **Capability check** — `canReceiveAlerts()` in `src/lib/push.ts`: secure origin +
  service worker support + `PushManager` in window + `Notification` defined +
  `!iosNeedsInstall()` (existing helper, `:23`). Gates every alert UI element.
- **Enrollment** — if toggling on and the device has no active subscription, call
  the existing `enablePush()` flow inline; on permission denial revert the toggle
  and show a hint.
- **Presence reporting** — extend the existing visibility/focus reporting
  (`src/App.tsx:87-94`) to include the active terminal id, report on active-tab
  change, and report away (`activeTerminalId: null`) immediately on blur/hidden so
  a just-pocketed phone does not sit in a stale 90s "present" window.
- **Settings cleanup** — remove the global "Notify when a thread finishes" toggle
  (`SettingsModal.tsx:364`), the `notify` setting (`stores/settings.ts:28`), and the
  foreground `maybeNotify` fallback (`App.tsx:37-43`), all subsumed by this feature.
  Keep the per-device push enrollment toggle (`pushEnabled`).

### Deep-link

- **Push payload** carries `{ terminalId, sessionId }` (sessionId added for URL building).
- **Service worker** (`public/sw.js`): on `notificationclick`, if a dispatch window
  exists → `focus()` + `postMessage({ type: 'open-thread', terminalId, sessionId })`;
  else `openWindow('/p/<sessionId>/t/<terminalId>')` — the mobile shell's existing
  URL scheme, which it restores natively on cold start.
- **Warm path**: the message becomes a `useUI.pendingOpenThread` intent; the live
  shell consumes it (desktop: `loadTabs` + `setActiveTab`; mobile:
  `openThreadFromList`, which seeds the project and builds the history stack).
- **Desktop cold start**: `App` parses `/p/<sessionId>/t/<terminalId>`
  (`lib/deepLink.ts`) after tab hydration (hydration would otherwise overwrite the
  restored tab), converts it to the same intent, and cleans the URL with
  `history.replaceState`. Unknown/archived thread → open normally, no error UI.

### Data flow

```
Claude/Codex hook or permission membrane
  → StatusService.apply()  (working → needs_input | waiting)
    → threadSettledHook(terminalId, status)
      → terminal.config.alertsEnabled?  ── no → done (status broadcast only)
      → yes → for each push subscription:
          present && activeTerminalId === terminalId? ── yes → skip
          else → webpush.send({ title: label, body, tag: terminalId,
                                data: { terminalId } })
  → device shows notification
  → tap → SW notificationclick → focus/open → activate thread tab
```

## Edge cases

- **Dead subscriptions:** pruned on 404/410 (existing behavior).
- **State flapping:** settled hook only fires on genuine `working →` edges;
  notification tag collapses same-thread repeats.
- **Stale presence:** explicit away report on blur/hidden + existing 90s TTL
  backstop.
- **Push failure:** best-effort; logged; never blocks status broadcast.
- **Existing users of the global toggle:** no migration — it meant "all threads",
  and auto-arming every bell would be noise. The setting disappears; users opt in
  per thread.
- **Bell on a thread that is deleted/archived:** flag dies with the config blob;
  deep links to missing threads open the app normally.

## Testing

- **Unit (core):** settled-hook gate (off → no send, on → send); presence matrix
  (away / present-viewing-this / present-viewing-other); alerts endpoint merges
  without clobbering other `config` keys.
- **E2E:** `verify` harness — isolated daemon on fake HOME, toggle via API, drive a
  status transition, assert against a mocked web-push transport.
- **Manual:** phone PWA end-to-end (arm bell → lock phone → thread finishes →
  notification → tap → correct terminal); desktop browser tab; bell UI absent in
  iOS Safari in-browser.

## Out of scope

- Per-device × per-thread alert preferences (rejected Approach 2).
- Contextual/model-generated notification bodies.
- Alert sounds, badges, or notification actions beyond tap-to-open.
- Any URL routing framework — deep links reuse the existing `/p/…/t/…` mobile scheme.
