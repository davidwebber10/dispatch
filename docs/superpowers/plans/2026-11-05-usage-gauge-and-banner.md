# Usage gauge, paused banner and threshold alert: spec and build plan

Planned against origin/main at `0f0dae51` (v3.10.6). Input: research thread `usage-limit-visibility`
(6dd6941b), option 1. Ledger N7 set the default threshold at 80 percent. Ledger N8 (coordinator
spawn guard) is out of scope. Its interaction points are listed at the end.

## Problem

Dispatch already detects Claude and Codex limits, pauses the thread and wakes it after the reset.
The numbers only show in one thread's Details panel and the Context popup. Nothing warns before
the limit. Nothing global shows that the whole fleet is paused. The first-pause note to Chat is
sent with `deliver:false`, so nobody is alerted.

Claude Code 2.1.316 sends `rate_limit_event` on every turn with `unifiedWindows.five_hour` and
`unifiedWindows.seven_day` utilization, even at 46 percent. The existing spec says the CLI only
reports above about 90 percent. That was true for 2.1.309 and is now wrong.

## What ships

1. **Usage chip.** Shows the 5-hour and weekly percentages. Turns amber at the warning threshold.
   Turns red while a thread of that provider is paused on a limit.
2. **Paused banner.** Red, global, shown while any thread is paused on a limit:
   `Claude agents paused: session limit, resumes 1:10 AM (3 threads)`. A per-device toggle hides it.
3. **Threshold push.** One web push per limit window when a window crosses the threshold.
4. **`usage-limits` broadcast.** Throttled. Sent when a snapshot is recorded, a pause starts or
   ends, or the settings change.
5. **Settings.** A new `Usage limits` section with the threshold, the push toggle and the banner toggle.
6. **Copy fix.** Remove the "under 90 percent" claims.

## Settings: where they live and why

Today there are two kinds of setting:

- **Per-device**, in `localStorage` through `packages/web/src/stores/settings.ts` (`useSettings`,
  keys `dispatch:*`). Examples: `showPrettyHint`, `showPinnedFiles`, `mobileViewMode`, `pushEnabled`.
- **Daemon-wide**, in an `app_state` JSON blob, behind `routes/*-settings.ts`. Examples:
  `harness_settings` (`settings/harness-settings.ts`, `/api/settings/harnesses`) and telemetry
  (`routes/telemetry-settings.ts`, `/api/settings/telemetry`, a plain GET/PUT).

The settings UI is `packages/web/src/components/settings/`. `sections.tsx` declares each section
once and both the desktop `SettingsView` and the phone `MobileSettings` render it.
`TelemetrySetting.tsx` is the pattern for one daemon-backed row.

| Setting | Scope | Storage | Default | Validation |
|---|---|---|---|---|
| Warning threshold | Daemon-wide | `app_state` key `usage_limit_settings` | 80 | Integer 50 to 99. A number is rounded, then clamped. Anything else is a 400. |
| Push when a limit crosses the threshold | Daemon-wide | same blob | on | Boolean, else 400 |
| Show the paused banner | Per-device | `localStorage` `dispatch:usageBanner` | on | Boolean |

Why the threshold is daemon-wide: the daemon sends the push, and the amber chip must agree with
the push. Two devices with two thresholds would disagree about "near the limit".

Why the push has its own toggle and not the banner toggle: the banner toggle is per-device. The push
fans out from the daemon to every subscribed device. One device's banner choice cannot switch off
pushes to the other devices. A device that has push off in General already gets no pushes. A
per-device push opt-out would need a per-subscription preference. That is a follow-up, not this build.

**Applies without restart.** `PUT /api/settings/usage-limits` writes the blob, updates the gauge
service in memory and broadcasts `usage-limits` with the new threshold. Every open client recolors
the chip on that event. The banner toggle is a zustand field, so it applies on the next render.

**Threshold change and pushes.** Changing the threshold never sends a push by itself. Windows that
are already at or above the new level are marked as alerted for their current window. This avoids a
push the moment the owner drags the stepper. Raising the threshold does not re-arm a window that
already alerted.

## Behavior details

**Windows that count.** `five_hour`, `seven_day`, and the per-model weekly ones
(`seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`). Not `overage` (usage credit).
Codex: `five_hour` and `seven_day`.

**Chip content.** `5h 46%  wk 21%`. Amber when any counted window is at or above the threshold.
The tooltip or popover names the window. Red when that provider has an active pause row.

**No data yet.** The chip is hidden until any provider has a snapshot. The Settings section shows
"No figures reported yet". Reason: a placeholder chip on a fresh install is noise.

**A window past its reset.** That window shows `–`, not the old figure, and does not count toward
amber. Same rule `windowLabel` uses today.

**Stale figures.** Claude CLI (terminal) threads do not stream, so they never update the snapshot.
The chip shows the latest figure any Pretty thread or Chat reported. If `asOf` is older than 30
minutes the chip renders dimmed. The popover shows `As of 12:40 PM` and one line: "Only Pretty
threads and Chat report usage. CLI threads do not."

**Codex freshness.** Today Codex figures refresh only when a Details panel asks
(`routes/usage-limits.ts`, `refreshCodex`). A gauge needs a daemon-side refresh. Move `refreshCodex`
into `limits/codex-refresh.ts`. The gauge tick (60 s) refreshes from the most recently active Codex
thread, only if a Codex thread was active in the last 10 minutes. The existing 30 s per-thread
throttle stays.

**Several providers and accounts.** The snapshot store keeps one snapshot per provider, for the
account that reported last. The chip shows one provider: the one with the highest counted window.
A small provider mark (`C` or `X`) leads the chip when more than one provider has data. The popover
lists every provider with its plan, windows, reset times and `As of`. An account switch replaces the
snapshot. The alert key includes the account, so a new account can alert in its own window.

**Paused banner.** Built from `usage_limit_parks` rows in state `parked` or `capped`, grouped by
provider. Copy:
- `Claude agents paused: session limit, resumes 1:10 AM (3 threads)`. The time is the earliest
  `resets_at`. With no readable reset: `reset time unknown`.
- Mixed kinds use the latest kind. Weekly over session.
- Capped rows add: `, 1 stopped after 5 tries`.
- Chat's own park counts as one thread and the banner says `Chat` when it is the only one.
- Click opens the first paused thread. A dismiss `×` hides it on this device until the next pause
  episode (a new earliest `parked_at`). The toggle hides it everywhere on this device.

**Push copy.** Template only, no model content. Title `Claude usage at 82%`. Body
`Session (5h) window, resets 1:10 AM.` Tag `usage-<provider>-<window>` so repeats coalesce. Click
opens `/`.

**One push per window.** Alert key `provider|account|windowType|resetsAt` with `resetsAt` rounded to
10 minutes, in case the reset time jitters between events. Stored in `app_state`
`usage_limit_alerts` so a restart does not re-send. Keys past their reset are pruned on each write.

**Broadcast throttle.** At most one `usage-limits` event per 5 seconds, trailing edge, and only when
the payload changed after rounding percents to integers. A pause starting or ending and a settings
PUT skip the wait and send at once.

## Event and API shape

```ts
// broadcast and GET /api/usage-limits/summary return the same body
type UsageSummary = {
  type: 'usage-limits';
  warnPercent: number;            // daemon threshold
  providers: {
    provider: 'claude-code' | 'codex';
    plan?: string;
    asOf: number;
    windows: Record<string, { usedPercent: number | null; resetsAt: number | null }>;
  }[];
  paused: {
    provider: string;
    kind: 'session' | 'weekly' | 'usage' | string;
    earliestResetsAt: number | null;
    threads: number;
    capped: number;
    chat: boolean;                // Chat's own park is among them
    firstTerminalId: string;      // for the banner's click (CHAT_ID when Chat is the only one)
    firstSessionId: string | null; // the click needs the project too
    episodeStartedAt: number;     // earliest parked_at, keys the per-device dismiss
  }[];
};
```

Account ids are not sent to the browser. The current snapshot for a provider is always the current
account, through the existing `accountFor`.

## Tasks, in order

1. **Gauge settings, daemon.** New `packages/core/src/limits/gauge-settings.ts`: `get(db)`,
   `set(db, patch)`, `sanitize()`. Key `usage_limit_settings`. Defaults `{ warnPercent: 80,
   pushOnWarn: true }`. New route `packages/core/src/routes/usage-limit-settings.ts`, mounted at
   `/api/settings/usage-limits` in `packages/core/src/server-routes.ts` beside telemetry.
2. **Pause-change hook.** `packages/core/src/limits/service.ts`: add `addChangeListener()` and call
   it wherever a park row is written or removed (`park`, `tick`, `onUserMessage`, `onStopped`,
   `onTurnEnded`, `onTurnSettled`, `restore`). Add `db/usage-limits.ts` `listPaused()` for
   `parked` and `capped` rows.
3. **Snapshot hook.** `packages/core/src/limits/snapshot.ts`: `record()` returns whether anything
   changed, or add an `onRecord` listener. Fix the `unifiedWindows` comment (line 19).
4. **Gauge service.** New `packages/core/src/limits/gauge.ts`: builds `UsageSummary`, owns the
   broadcast throttle, the threshold crossing check, the alert store and the Codex refresh tick.
   Dependencies injected: `db`, `snapshots`, `parks`, `broadcast`, `push`, `now`, `accountFor`.
5. **Codex refresh.** Move `refreshCodex` from `routes/usage-limits.ts` to
   `packages/core/src/limits/codex-refresh.ts`. The route and the gauge both call it.
6. **Push without a thread.** `packages/core/src/push/service.ts`: add `notifyAccount({ title, body,
   tag })`. Same sending, pruning and revoke checks as `notifyThread`, no presence skip.
   `packages/web/public/sw.js`: use `d.tag` when there is no `terminalId`. Click with no thread
   already opens `/`.
7. **Wire it.** `packages/core/src/server.ts` near line 619: build the gauge, pass `broadcaster`
   and `pushService`, subscribe to the snapshot and pause hooks, start its tick. Add
   `GET /api/usage-limits/summary` in `routes/usage-limits.ts`. The settings PUT calls
   `gauge.settingsChanged()`.
8. **Web store.** New `packages/web/src/stores/usageLimits.ts`: holds the summary, `load()`,
   `applyEvent()`. Register in `App.tsx` `onEvent` and reload in the reconnect branch. Add
   `api.getUsageSummary`, `api.getUsageLimitSettings`, `api.setUsageLimitSettings` to
   `api/client.ts` and types to `api/types.ts`.
9. **Per-device toggle.** `packages/web/src/stores/settings.ts`: `showUsageBanner`, key
   `dispatch:usageBanner`, default true, setter. Dismiss state in
   `packages/web/src/stores/dismissedNotices.ts` keyed by `episodeStartedAt`.
10. **Chip.** New `packages/web/src/components/layout/UsageChip.tsx` and a pure
    `usageGauge.ts` (pick provider, color, labels, staleness, banner copy). Built as
    `usageGauge.ts`, not `usageChip.ts`: beside `UsageChip.tsx` that name collides on a
    case-insensitive disk. Reuse `whenLabel` and `TYPE_LABEL`
    from `components/inspector/usageLimits.ts`.
    - Desktop: in `IconRail.tsx` above the connection dot. The rail is 64 px wide, so two stacked
      lines: `5h 46` and `wk 21`. Click opens a popover with the full table.
    - Phone: in the `MobileApp.tsx` header next to `AlertBell`, compact, one value: the higher of
      the two windows, `46%`. Tap opens a bottom sheet with the full table. Check 375 px width.
11. **Banner.** New `packages/web/src/components/layout/UsageBanner.tsx`. Built as a flow strip, not
    an overlay like `AuthBanner`: mounted in `AppShell.tsx` above every desktop view and in
    `MobileApp.tsx` under the header. On the phone it sits under the header, one line, wraps to two.
12. **Settings section.** New `packages/web/src/components/settings/UsageLimitsSection.tsx`, added
    to `sections.tsx` as key `usage`, label `Usage limits`, blurb `Warning level, alerts, banner`.
    Rows: `Warn at` stepper 50 to 99 (step 5, typed value allowed), `Push alert at the warning
    level` toggle, `Show the paused banner on this device` toggle, and a read-only table of the
    current figures. Label which rows are daemon-wide ("all devices") and which are this device.
13. **Copy fix.** `components/inspector/usageLimits.ts` line 16: `Under the warning level` becomes
    `No figure reported`. Line 28 comment: CLI 2.1.316. `packages/core/tests/structured/fake-claude.mjs`
    line 71 comment. `docs/superpowers/specs/2026-10-24-usage-limits-details-design.md` lines 26 to
    30 and line 50: utilization now arrives every turn on 2.1.316. Older CLIs may still omit it.
14. **Release note.** Part of the release, not this PR. Skipped in the build: the version bump and
    `docs/releases` come in a separate `chore(release)` commit on main.

## Edge cases

- No snapshot for any provider: chip hidden, banner hidden, settings shows "No figures reported yet".
- Utilization `null` on an older CLI: window shows `–`, never counts toward amber.
- Window past its reset with no new event: `–`, not amber. Alert key for that window is pruned.
- Out-of-order report: `record()` already ignores reports older than the stored one.
- Account switch mid-window: new snapshot, new alert keys. Old keys prune at their reset.
- Threshold PUT of `"85"` (string), `null`, `NaN`: 400. `85.4`: stored as 85. `30`: stored as 50.
  `120`: stored as 99. A corrupt blob on read falls back to the defaults.
- Threshold lowered below current usage: chip goes amber at once, no push.
- Daemon restart: alert keys persist, so no repeat push. Summary reloads on reconnect.
- Many Pretty threads streaming at once: throttle caps events at one per 5 s.
- Chat is the only paused thread: banner says `Chat paused: ...`.
- A paused thread archived: the tick already removes the row. The change hook fires.
- Capped rows only: banner says `Claude agents stopped: session limit, auto-resume gave up (2 threads)`.
- Push off on every device, or no subscriptions: alert key is still written, nothing sent.
- Banner toggle off on the phone, on on the desktop: each device honors its own.

## Test plan

Core (vitest, single files while building, full suite once at the end):
- `limits/gauge-settings.test.ts`: defaults, round and clamp, rejects, corrupt blob.
- `routes/usage-limit-settings.test.ts`: GET, PUT, 400s, PUT broadcasts once.
- `limits/gauge.test.ts`: summary shape; amber math; one push per window; no push on threshold
  change; no repeat after restart (new instance, same db); account switch alerts again; throttle
  (fake timers, 20 records in 5 s give 1 event); pause change sends at once; 'overage' ignored.
- `limits/service.test.ts`: change listener fires on park, wake, cap, remove, restore.
- `push/service.test.ts`: `notifyAccount` sends to all, prunes 404 and 410, skips revoked.
- `routes/usage-limits.test.ts`: summary route; Codex refresh still throttled after the move.

Web (vitest + testing-library):
- `layout/usageChip.test.ts`: provider pick, amber at threshold exactly, red on pause, dim when
  stale, `–` past reset, hidden with no data.
- `layout/UsageChip.test.tsx` and `UsageBanner.test.tsx`: render, copy, toggle off hides, dismiss
  holds until a new episode.
- `stores/usageLimits.test.ts`: `applyEvent`, reload on reconnect.
- `settings/UsageLimitsSection.test.tsx`: stepper clamps, PUT error rolls back.
- `inspector/usageLimits.test.ts`: new copy.

End to end with the `verify` skill on an isolated daemon: feed a fake `rate_limit_event` at 0.85
through `tests/structured/fake-claude.mjs`, expect one `usage-limits` event with amber data and one
`notifyAccount` call. Park a thread, expect the banner payload. Phone layout checked at 375 px.

## Risks

- **Event volume.** Every turn of every Pretty thread records a snapshot. Mitigated by the 5 s
  trailing throttle and the changed-payload check.
- **Stale numbers look current.** CLI threads never report. Mitigated by dimming after 30 minutes
  and the `As of` line.
- **Push fatigue.** Two windows times two providers can mean four pushes in a bad hour. Tags
  coalesce on the device. The push toggle turns it off.
- **Rail space.** The 64 px rail is tight. If two lines do not fit at the larger font sizes, fall
  back to one value and the popover.
- **CLI format drift.** The event shape is undocumented. `parseClaudeRateLimit` already ignores
  unknown fields. A missing figure shows `–`.

## Size and review

About 1.5 days: core 0.75 (settings, gauge, hooks, push), web 0.75 (store, chip, banner, section,
phone layout). No full design review. It changes no agent behavior. A short UI check of the phone
header and the rail at 375 px and at the largest font size is enough.

## Coordinator spawn guard (N8): interaction points, not built here

- `gauge.ts` should export `nearLimit(provider)` and `activePauses(provider)`. A future guard in
  `packages/core/src/overseer/agency-mcp.ts` (`spawn_agent`, `start_agent`) can call them.
- The guard's hard level (95 suggested) should be its own setting, not this threshold. This one is
  a warning, the guard blocks work.
- A coordinator notice on pause start would hang off the same pause-change listener from task 2.
- Keep the gauge free of overseer imports so N8 can land without touching this code.

## Owner decisions

- **UG-1.** Push governed by its own daemon toggle (recommended) or by the banner toggle.
- **UG-2.** Phone chip shows always when data exists (recommended) or only at amber and red.

## Build record (2026-11-05, branch `feat/usage-gauge-and-banner`, issue #127)

Built against origin/main `0f0dae51`. Every file and line reference above matched. Where the build
differs from the plan:

- **Pure module name.** `layout/usageGauge.ts` and `usageGauge.test.ts`, not `usageChip.ts`. It also
  holds `bannerText`, so the chip popover and the banner share one copy.
- **Banner mount.** `AppShell.tsx` (desktop) and `MobileApp.tsx` under the header, not `App.tsx`.
- **Reconnect reload.** In `lib/resync.ts`, which the `App.tsx` reconnect branch already calls.
- **Codex refresh.** `limits/codex-refresh.ts` exports `createCodexRefresh()`. The daemon builds one
  and hands it to the route and the gauge, so the 30 s per-thread throttle is shared.
- **Summary shape.** Adds `chat` and `firstSessionId` to each paused group. The click needs both.
  `GET /api/usage-limits/summary` answers 503 when no gauge is wired (`createApp` in tests).
- **Chip pick.** A provider with a pause wins, so the red state is never hidden behind another
  provider. `wk` shows the highest weekly-type window (`seven_day` or a per-model one).
- **Throttle dedupe.** `asOf` moves on every turn, so the changed-payload check compares it at
  5-minute grain. Percents are integers already.
- **Push copy.** Per-model windows read `Opus weekly`, `Sonnet weekly`, `Fable weekly`.
- **Fake CLI.** `TRIGGER_RATE_EVENT:<5h>:<week>[:status]` sends any utilization with resets 2 hours
  and 3 days out. Used by the end-to-end check.
- **Largest font size.** The rail labels use fixed px, like the rest of the rail, so the app's font
  settings do not change them. Checked at 1x and 1.5x device scale. `5h 100` fits the 52 px button.

End-to-end check on an isolated daemon (port 3999, fake HOME, a `claude` shim running
`tests/structured/fake-claude.mjs`): 46% gave one event 5 s after the turn and a plain chip. 85%
then 86% inside 5 s gave one event, an amber chip and one alert key. A threshold PUT broadcast
within 13 ms and recolored the chip. Lowering it from the page wrote no new key. A rejected event at
100% plus two limit stops gave a red chip and `Claude agents paused: session limit, resumes 3:11 PM
(2 threads)`. Messaging each thread dropped the count to 1, then cleared it. No real device push:
there was no subscription, so a send was proved by the alert key and the `notifyAccount` unit tests.
