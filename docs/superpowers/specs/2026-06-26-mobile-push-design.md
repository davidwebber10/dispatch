# Mobile Push Notifications (thread finished / needs input) — Design

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

Dispatch can run long Claude/Codex threads; today the only alert is an in-tab `Notification` (`App.tsx`) that fires only when the browser tab is open-but-hidden. There's no way to learn a thread finished (or is blocked waiting for you) when the app is closed/backgrounded on your phone. We want real **web push** that fires when a thread stops working — but only when you're not actively looking (no spam after every interactive turn).

## Goal

When a thread transitions out of `working` → `idle`/`done`/`needs_input`, send a web-push to the user's subscribed devices **that are not currently foregrounded**, with a deep-link to that thread. Enabled via a Settings toggle (with iOS install guidance). Supersedes the in-tab "input needed" alert.

## Decisions (from brainstorming)

- **Trigger:** thread goes `working` → `idle`/`done`/`needs_input` (both completion AND needs-input).
- **Away-only:** suppress push to any device currently foregrounded (you'll see it in-app); push to backgrounded/closed devices.
- **Transport:** Web Push API + VAPID. iOS requires an installed PWA (Home Screen) on iOS 16.4+ — the enable flow detects this and guides the user.
- **Presence channel:** lightweight HTTP (`POST /api/push/presence`) on `visibilitychange`/focus/blur; stale presence (no recent foreground ping) counts as away.

## Architecture / components

**Server (core)**
- Dependency `web-push`. VAPID keypair generated once into `~/.dispatch/push.json` (0600; private key never sent to clients). `GET /api/push/key` → public key.
- New SQLite table `push_subscriptions` keyed by a client `deviceId`: `{ device_id PK, endpoint, p256dh, auth, created_at, updated_at }` (upsert per device).
- `routes/push.ts`: `GET /key`; `POST /subscribe` ({deviceId, subscription}); `POST /unsubscribe` ({deviceId}); `POST /presence` ({deviceId, foreground}).
- `PushService`: in-memory `presence: Map<deviceId,{foreground,ts}>`; `setPresence(deviceId, fg)`; `notifyThread(terminalId, threadStatus)` — resolves the thread's project + label, builds a payload, and sends a web-push to every subscription whose device is NOT currently foregrounded (foreground && ts fresh). Prunes subscriptions on 404/410. Wraps sends in try/catch so a push failure never affects the daemon.
- **Trigger wiring:** `StatusService` already broadcasts `terminal:status` with `threadStatus`. Add a transition check there: when the previous thread status was `working` (or starting) and the new one is `idle`/`done`/`needs_input`, call `pushService.notifyThread(terminalId, newStatus)`. Fire once per transition (the service already knows prev/next when it updates DB status). Payload: `{ title: <project name>, body: <thread label> + (' finished' | ' needs your input'), data: { url: /deep-link-to-thread, terminalId, projectId } }`.

**Service worker (`packages/web/public/sw.js`)**
- `push`: `event.waitUntil(self.registration.showNotification(payload.title, { body, icon:'/icons/icon-192.png', badge, tag: terminalId (coalesce per thread), data }))`.
- `notificationclick`: close, then focus an existing client and navigate (or `clients.openWindow`) to `data.url`.

**Client (web)**
- Stable `deviceId` in localStorage (uuid).
- Presence: on `visibilitychange`/focus/blur, `POST /api/push/presence { deviceId, foreground }` (foreground = visible && focused). Sent on mount + each change.
- Enable flow (Settings "Notifications" toggle, replacing "Alert when input needed"): feature-detect (`serviceWorker`, `PushManager`, `Notification`); on iOS detect installed PWA via `matchMedia('(display-mode: standalone)')`/`navigator.standalone` and, if not installed, show inline guidance ("Add Dispatch to your Home Screen to enable push on iOS") instead of failing. On enable: `Notification.requestPermission()` → `registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: <vapidKey from /api/push/key> })` → `POST /api/push/subscribe`. On disable: unsubscribe + `POST /api/push/unsubscribe`.
- When push is subscribed, the existing in-tab `new Notification` path in `App.tsx` stands down (avoid double-notifying a hidden-but-open tab, which counts as away and will get a push); it remains only as a fallback when push isn't set up/supported.

## Data flow

Thread finishes/needs-input → `StatusService` detects the working→idle/done/needs_input transition → `PushService.notifyThread` → for each subscription whose device isn't foregrounded, `web-push.sendNotification(sub, payload)` → device SW `push` → notification → tap → SW `notificationclick` → app opens to that thread.

## Error handling

VAPID/`push.json`: generate on first start if absent. A send that returns 404/410 → delete that subscription. Any send error is caught and logged (no secret material) and never blocks the status pipeline. Presence missing/stale → treat as away (fail toward notifying). iOS-not-installed → the toggle explains rather than throwing. Permission denied → toggle reflects off.

## Testing

- Routes: `GET /key` shape; `subscribe`/`unsubscribe` upsert/delete a row; `presence` updates state. (in-memory db via createApp)
- `PushService.notifyThread`: with a mocked sender — sends only to non-foregrounded devices; coalesces (tag) per thread; prunes a 410 subscription; no-ops when no subs.
- Transition logic: a `working→idle` triggers `notifyThread` once; `working→working`/repeated `idle` does not.
- Web/SW: the SW push/notificationclick + the real device delivery are manual-verified (install PWA on iOS, run a thread, background the app, confirm the push + tap-through). jsdom can't exercise the SW.

## Out of scope (follow-ups)

Per-project / per-thread notification toggles; notification grouping beyond per-thread tag; desktop OS push (this targets mobile/PWA, though it works on any push-capable browser); presence over WS (HTTP is enough for v1).

## Decision

Build on the existing PWA service worker + status pipeline. The only genuinely new infra is VAPID + subscriptions + the away-only presence gate; the trigger is a small hook at the existing `StatusService` transition point.
