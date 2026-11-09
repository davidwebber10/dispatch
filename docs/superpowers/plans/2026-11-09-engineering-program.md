# Engineering program for v4.5.0: spec and implementation plan

Date: 2026-11-09. Branch: `claude-resets` (becomes release v4.5.0).
Input: `docs/review/2026-11-09-engineering-review.html` (five reviews, top 15, three-phase roadmap).
The owner approved Phase 1, Phase 2 and Phase 3.

This document is a plan. It gives file paths, signatures, test names and assertions. It contains no product code.

Paths are relative to the repository root. Line numbers are from commit `77208fcb`. They move as work lands; each
worker must locate the symbol again before an edit.

---

## 0. How to read this plan

- A **wave** is a set of workstreams that run at the same time, each in its own git worktree.
- A **workstream** has an id (`W1-A`), an owner list of files, the interfaces it gives and takes, tests to write
  first, acceptance criteria and an effort (S = hours to a day, M = days, L = a week or more).
- "Owns" means: only that workstream may change the file in that wave. A shared file names the exact region.
- "Tests first" means: write the named test, see it fail, then write the code.

### 0.1 What the code check found

Each review item was checked against the code before it was planned.

| Review claim | Evidence in the code | Result |
|---|---|---|
| Transcript pages read the full file, synchronously | `packages/core/src/sessions/service.ts:1085`, `:1104` (`getConversation`), `:1178` (`searchConversation`) call `fs.readFileSync` then `split('\n')` | Confirmed |
| Full-file reads at turn end, spawn and token totals | `packages/core/src/sessions/cc-sessions.ts:111` (backfill, cap 16 MB at `:48`), `:133` (`findNewestUnresolvedUserUuid`, called from `service.ts:412`), `:250` (token totals) | Confirmed |
| Config is one untyped JSON column, written whole | `packages/core/src/db/terminals.ts:178` `updateConfig(db, id, config: Record<string, any>)`; 33 call sites: 26 in `sessions/service.ts`, 3 in `status/service.ts` (`:283`, `:356`, `:448`), 2 in `overseer/ledger-service.ts` (`:518`, `:530`), `server-routes.ts:203`, `sessions/interim-recap.ts:62`. No `TerminalConfig` type exists. | Confirmed (review said 23 and 31; the count is 33) |
| `SessionService` is 3,691 lines with 30 setters | `wc -l` = 3,691; 30 `set*` methods | Confirmed |
| Two composition roots | `packages/core/src/server.ts:403` `createApp`, `:515` `startServer`; the watch dispatcher is built twice (`:457`, `:692`) | Confirmed |
| Three copies of ring trim and turn settle | `MAX_EVENTS = 5000` at `structured/manager.ts:307`, `codex-manager.ts:36`, `grok-manager.ts:51`; 12 trim sites; `settleTurn` at `codex-manager.ts:569` and `grok-manager.ts:405`; two JSON-RPC connection classes (`codex-manager.ts:52`, `grok-manager.ts:60`) | Confirmed |
| Delivery is fire-and-forget | `sessions/service.ts:1441-1462` `deliverToStarter` logs and drops when the starter is not running; `sessions/watch-dispatcher.ts:144-152` marks a watch fired even when delivery threw | Confirmed |
| Watches fire on every status apply, not on a change | `status/service.ts:437` calls `onWatchStatus` on every `apply`, with no comparison to `prior` (`:425`) | Confirmed |
| A restart can leave a run open and stop the schedule | `db/agents.ts:203-213` `listDueSchedules` skips a schedule that has a run in `queued/starting/working/needs_input`; only role runs are swept (`db/agents.ts:312`, `roles/service.ts:516`); no boot cleanup exists in `server.ts:1284-1305` | Confirmed for ordinary schedules; role runs are closed only after their wall-clock cap |
| No stall watchdog | No code compares "now" to a last-frame time. The existing 30 s tick is `agentSchedulerInterval` at `server.ts:1316-1322` | Confirmed |
| Boot kickstart covers Claude and Codex only | Comment and code at `sessions/service.ts:3430-3443` | Confirmed |
| No idempotency on message POST | `routes/terminals.ts:154` has no key or dedup | Confirmed |
| `terminal:activity` is sent on every monitor update | `terminal-monitor.ts:209-222` | Confirmed (the busy/idle filter is absent) |
| No compression on API JSON or WebSocket frames | Only `web-assets.ts` uses `zlib`; `ws/client-wss.ts:10` builds the server with no `perMessageDeflate` | Confirmed |
| `index.html` is read once at boot | `server.ts:1058-1067` | Confirmed |
| Absolute-path read has no deny-list | `routes/files.ts:201-204` `resolveRead` returns any absolute path; `:313` skips containment for it | Confirmed |
| Secret reveal, integration export and pair-code are not strict | `routes/secrets.ts:46` (default `ownerOnly` from `policyRouter`), `routes/integrations.ts:46`, `server-routes.ts:140` (`ownerOnly`). `ownerOnlyStrict` exists at `auth/route-policy.ts:171`. | Confirmed |
| Every thread gets the full Doppler token | `secrets/service.ts:178-187` `getSpawnEnv`; spread into the default spawn env at `server.ts:919`; given to PTY, structured, Chat and ACP managers at `server.ts:939-945` | Confirmed |
| No Cloudflare Access JWT check | No match for `cf-access` in `packages/core/src`; an allow-listed host is trusted at `auth/access-gate.ts:100` | Confirmed |
| Sign-in limiter can be cleared | `auth/access-gate.ts:307-310`: over 1,000 entries, `failures.clear()` | Confirmed |
| No bind option | `server.ts:1192`, `:1204` call `server.listen(port)` with no host | Confirmed |
| Conflict marker in the network doc | `docs/network-access.md:179` is `||||||| 778d03a0`, followed by stale base text | Confirmed |
| Sidebar re-renders on each status event | `packages/web/src/stores/tabs.ts:272-279` rebuilds every project array on each `terminal:status`; 13 live components select all of `byProject` | Confirmed |
| No root error boundary; untyped events | Only `packages/web/src/plugins/PluginBoundary.tsx`; `api/events-socket.ts:2` is `{ type: string; [k: string]: unknown }` | Confirmed |
| Four lazy chunks, no `manualChunks` | `App.tsx:64`, `LazyTerminalTab.tsx:7`, `TabHost.tsx:20-21`, `MobileApp.tsx:57`; `vite.config.ts:20` has only `outDir` | Confirmed (five `lazy` calls, four distinct chunks) |
| Dead code | `components/board/**` has no importer outside itself; `stores/ui.ts:64` maps `'board'` to `'workspace'`; `overseer/components/DelegateModal.tsx` has no importer; `layout/TabBar.tsx` has no importer; `lib/utils.ts` is the only user of `clsx` and `tailwind-merge`; no file imports `lucide-react` or `class-variance-authority` | Confirmed. `overseer/data.ts` is partly live: `CANNED`, `btn`, `mission`, `outc`, `th` are imported by `live.ts:16`, `store.ts:31`, `components/Stream.tsx:41` |
| Hardcoded "Control Plane" | `stores/tabs.ts:62` returns the literal; the setting is `coordinatorName` with `useDispatchName` at `stores/settings.ts:289` | Confirmed |
| Palette is a stub | `components/CommandPalette.tsx` is 67 lines: views, settings sections, plugin commands | Confirmed |
| Four pending-intent fields | `stores/ui.ts:46-59` | Confirmed |
| Client computes "busy" again | `components/tabs/chat/useStructuredChat.ts:315` plus 20 `setBusy` sites; the server sends a synthetic settle at `ws/structured.ts:144-146` to correct it | Confirmed |
| Compiler cannot find a missing `.js` | `tsconfig.base.json:5` is `moduleResolution: bundler`. A `--noEmit` run with NodeNext gives 7 errors, all in two test files: `src/conversation/task-notification.test.ts:5`, `src/conversation/transcript.test.ts:2` (TS2835) and five TS7006 in the second file | Confirmed. Source files are clean today |
| Tests ship in `dist` | `packages/core/tsconfig.json` includes all of `src`; `dist/sessions` holds 25 `*.test.js` files | Confirmed |
| No index on four columns | No `CREATE INDEX` names `terminals` or `agent_runs` in `packages/core/src/db` | Confirmed |
| Lifecycle trim on every event | `runtime/diagnostics.ts:8` | Confirmed |
| Plugin SDK gives raw `api` and stores | `packages/web/src/plugins/sdk.tsx:158`, `:172`, `:203`, `:213`; both bundled plugins use them (`packages/plugins/coach/web.js`, `packages/plugins/previews/web.js`) | Confirmed |

Not checked by count (accepted from the review): the 2,375 inline styles, 439 raw buttons, bundle sizes, the 316 ms figure.

---

## 1. Global constraints

Every workstream obeys all of these.

**Scope and product rules**

1. Do not merge Chat and the Control Plane. Do not rename folders or concepts. See section 7.
2. No emoji in the UI. Use Phosphor icons for every control.
3. Never add a "This thread is asking you" strip or an Answer popup. `packages/web/src/lib/noAskStrip.test.ts` must stay green.
4. No new background periodic scan where an event hook exists. Write the record when the event happens.
   The stall watchdog is the one exception: it rides the existing 30 s tick at `packages/core/src/server.ts:1316`.
   It adds no timer.
5. Nothing that works today may break. A security change that can change behaviour is opt-in, or it keeps the old
   behaviour for an existing install and documents the migration.

**Code rules**

6. ESM imports in `packages/core` and `packages/cli` need an explicit `.js` extension.
7. A new SQLite table or column uses the ordered `migrate(db, '<name>', fn)` style in `packages/core/src/db/schema.ts`.
   Use a migration name that carries the workstream id (example: `w2c-delivery-outbox`). This prevents number collisions.
8. A new runtime dependency needs a reason in the commit message. The daemon has 7 today. Prefer `node:` modules.
9. Every public route keeps a policy tag (`ownerOnly`, `ownerOnlyStrict`, `keyRoute`, `publicRoute`).
   `route-policy-completeness.test.ts` must stay green.

**Test and run rules**

10. Core tests: from `packages/core`, run
    `env -u DISPATCH_API -u DISPATCH_AUTH -u DISPATCH_SESSION -u DISPATCH_TERMINAL npx vitest run`.
11. Web tests: from `packages/web`, run `npx vitest run`.
12. During work, run the affected test files only. Before the report, run the full core suite and the full web suite (section 1A).
    Do not pipe a test run through `head` or `tail`. Write the output to a file, then read the file.
13. Never build into the main checkout `~/Sites/dispatch`. Build only in your own worktree.
14. Never start a daemon on port 3456. Never read or write `~/.dispatch`.
    For an end-to-end check use an isolated instance: `HOME=<scratch fake home> PORT=41xx node dist/server.js` (4100 to 4199).
15. Smoke-start the built daemon in the isolated instance before a workstream is called done. A missing `.js`
    extension passes the build and the tests, and then the daemon does not start.
16. All existing tests stay green. If a test must change, the commit message says why.

**Git rules (restate these in every worker brief)**

17. One worktree per workstream. Branch name: `v450/<id>` (example: `v450/w1-a`), cut from the wave base.
18. Commit early and often. Uncommitted worktree edits can be lost.
19. Never use bare `git stash` or `git stash pop`. The stash is shared with other sessions.
20. Never kill a process that you did not start. Retry a transient `index.lock`; do not delete it.
21. Move-only commits are separate from behaviour commits. A move-only commit says so in its message.
22. Dispatch each workstream to a fresh general-purpose worker, not to a fork.

---

## 1A. Testing strategy (binding for every workstream)

The owner asked for thorough tests. Each rule in this section is a condition of "done". A hand-off that does not show the
evidence is not accepted.

### 1A.1 Rules for each workstream

1. **Tests first.** Write each test in the "Tests first" list before the code. Run it and see it fail for the right reason.
   Put the failing output (test name and the assertion message) in the first commit message of that test, or in the hand-off.
2. **Affected files during work.** Run only the test files that the change touches.
3. **Full suites before the report.** In its own worktree the workstream runs the **full core suite and the full web suite**:
   - core: from `packages/core`, `env -u DISPATCH_API -u DISPATCH_AUTH -u DISPATCH_SESSION -u DISPATCH_TERMINAL npx vitest run > <scratch>/core.txt 2>&1`
   - web: from `packages/web`, `npx vitest run > <scratch>/web.txt 2>&1`
   - Read the files. Do not pipe a run through `head` or `tail`.
4. **Known failures.** At the plan commit, 2 tests fail in `packages/core/src/routes/files.test.ts`. Every other failure is a failure of the workstream.
   W1-B changes that file: it must name the 2 tests in its hand-off, show that the same 2 fail before its change, and not add a third.
   If a workstream repairs the 2, it says so.
5. **Manual verification.** Each workstream has a manual step against an isolated daemon, built in its own worktree:
   `HOME=<scratch fake home> PORT=41xx node packages/core/dist/server.js` (a free port from 4100 to 4199; never 3456; never the real `~/.dispatch`).
   - A core change is driven with `curl` and a WebSocket client script. The hand-off holds the commands and the answers.
   - A UI change is driven with Playwright against the isolated daemon. The hand-off holds the screenshots (light and dark theme, desktop width and phone width).
   - Agent processes come from the fake CLIs in `packages/core/tests/structured` (`fake-claude.mjs`, `fake-codex-app-server.mjs`). No real model call is made.
   - Do not press the empty-workspace "New Thread" button in a probe against a real daemon. Use the isolated instance only.
6. **Stop your own processes.** The workstream stops the isolated daemon that it started. It never stops another process.
7. **Hand-off content.** Test counts for both suites, the list of new test files, the manual verification record, and the numbers from 1A.3 where they apply.

### 1A.2 Regression tests for each bug class in the review

Each class gets a named test that fails on the old code. The owner workstream writes it; the wave integrator runs it on the merged branch.

| Bug class | Test (file, name) | Key assertion | Owner |
|---|---|---|---|
| Lost config update | `packages/core/src/sessions/thread-config.test.ts`, "two patches from two stale copies both land" | After read A, read B, patch A.x, patch B.y: both keys are present | W2-A |
| Lost config update, real path | `packages/core/tests/regression/config-lost-update.test.ts`, "a model switch during a status write keeps the scheduled wake" | Drive `SessionService` and `StatusService` on one database; no key is lost | W2-A |
| Lost delivery | `packages/core/tests/regression/lost-delivery.test.ts`, "a Finished notice sent while the coordinator is down arrives once after it starts" | Exactly one message reaches the fake coordinator; the outbox row is `delivered` | W2-C |
| Lost delivery, watch | same file, "a one-shot watch whose delivery failed fires on the next start" | `fired_at` is null before the delivery and set after it | W2-C |
| Duplicate delivery | same file, "the same settle event enqueues one row" ; `routes/terminals.test.ts`, "two POSTs with one key deliver once" | One row; one message | W2-C, W1-D |
| Stale working status | `packages/core/tests/regression/stale-working.test.ts`, "a working thread whose process is dead is explained and can be reset" ; `runtime/stall-watchdog.test.ts`, "flags a working thread with no frame" | The explanation names the dead process; the flag is set; the status is not changed by the watchdog | W1-D, W2-G |
| Stale working status, client | `packages/web/src/components/tabs/chat/useStructuredChat.test.ts`, "a replay with an open tool call and a header with turnOpen false shows not busy" | `busy === false` | W3-C |
| Restart recovery, runs | `packages/core/tests/regression/restart-recovery.test.ts`, "an open run with a dead terminal is closed at boot and the schedule fires again" | The run is closed; `listDueSchedules` returns the schedule | W1-D |
| Restart recovery, wakes and questions | same file, "a scheduled thread with a dead process is flagged" ; "a pending question is shown again after a new daemon on the same database" | Lifecycle event `wake.lost`; `getPendingPermission` returns the payload | W2-C |
| Restart recovery, history | `packages/core/src/routes/journal.test.ts`, "a Grok thread returns history after a new daemon instance" | Same items, same sequences | W3-D |
| Transcript paging blocks the loop | `packages/core/src/conversation/reader.test.ts`, "a large generated file: no event-loop block over 50 ms during a page read" | A 100 MB synthetic file (made in a temp dir, removed after); `perf_hooks.monitorEventLoopDelay` max under 50 ms; `fs.readFileSync` is not called. Use 20 MB when `CI=1` | W2-B |
| Sidebar re-render on each status event | `packages/web/src/components/sidebar/ProjectSidebar.test.tsx`, "a status event for project A does not render the ProjectCard of project B" | A render counter (`React.Profiler` `onRender`, or a counter in a mocked child) stays equal for project B | W1-F |
| Chat tree rebuilt on each key press | `packages/web/src/components/tabs/chat/Composer.test.tsx`, "typing does not call renderTimeline" | The spy call count does not change over 20 key presses | W1-F |
| Markdown parsed again on each delta | `packages/web/src/components/Markdown.test.tsx`, "a closed block is not parsed again when text is added after it" | Parser spy count per block is 1 | W2-E |
| Missing wire is a silent no-op | `packages/core/src/daemon/parity.test.ts`, "every service that production wires is also wired in the test build" | The two lists are equal | W3-A |
| History duplicates and loss | `packages/web/src/components/tabs/chat/useChatHistory.test.ts`, "two items with the same seq render once" | One row | W3-D |
| Secret read by a local caller | `packages/core/src/routes/files.test.ts`, "an absolute read of the access token answers 403" | 403 for every principal | W1-B |

### 1A.3 Load and performance checks, with numbers before and after

Each performance item reports a number from the wave base and a number from its branch, taken the same way on the same machine.
The hand-off holds both numbers and the command or script. Scripts live in `packages/core/scripts/perf/` and `packages/web/scripts/perf/` (new; owned by the workstream that needs them).

| Item | Measure | How | Owner |
|---|---|---|---|
| Transcript paging | Event-loop delay p99 and max, page time, RSS | Page a 100 MB synthetic transcript 50 times through the isolated daemon with `curl`; read `monitorEventLoopDelay` from a debug script | W2-B |
| Tail reads | Time of `findNewestUnresolvedUserUuid`, backfill and token totals on a 16 MB file | A script that calls each function 20 times | W1-E |
| JSON and WebSocket compression | Transfer size of `/conversation` (200 items) and of the first replay frames | `curl --compressed -w '%{size_download}'`; a WebSocket script that sums frame bytes | W1-E |
| Activity events | `terminal:activity` frames per minute with 10 fake busy terminals | A WebSocket script that counts frames for 60 s | W1-E |
| Sidebar renders | React commits per minute with 30 fake working threads | A vitest perf test with `React.Profiler`, and one Playwright run with the React profiler build | W1-F |
| Key press cost | Script time per key press in a 500-item chat | Playwright trace on the isolated daemon with a seeded thread | W1-F |
| Streamed markdown | Parser calls and long tasks during a 4,000-token streamed reply at 4× CPU throttle | Playwright with CPU throttle; the parser spy count from the unit test | W2-E |
| Entry bundle | Raw and gzip size of the entry chunk; chunk count | `check-bundle.mjs` output | W2-E |
| Structured ring | Heap with 30 fake threads after 200 streamed messages each; events in a replay | A script on the isolated daemon; `process.memoryUsage()` through a debug route that exists only under `NODE_ENV=test` | W2-D |
| Lifecycle trim and indexes | Time for 5,000 status events; query plan of the four indexed lookups (`EXPLAIN QUERY PLAN` shows the index) | A script on a temp database | W1-E |

A change that makes a number worse needs a reason in the hand-off, or it is not merged.

### 1A.4 Integration test plan for each wave

The integrator runs this on the merged wave branch, in a worktree, after the last merge of the wave.

1. `pnpm install` in the worktree. Build in the worktree.
2. Full core suite and full web suite (the commands of 1A.1). Only the 2 known failures are accepted, and only while they still exist.
3. `pnpm -C packages/core run typecheck` and `pnpm run lint` (from Wave 1 on). `check-bundle.mjs` (from Wave 2 on).
4. Every regression test of 1A.2 that exists at that wave, run by name.
5. **Smoke start** of the built daemon: `HOME=<scratch fake home> PORT=41xx node packages/core/dist/server.js`.
   `curl -fsS http://localhost:41xx/api/sessions` answers. The log has no import error.
6. **End-to-end pass of the main flows**, with Playwright and `curl` against that daemon, with the fake CLIs on `PATH`:

   | Flow | Steps | Pass when |
   |---|---|---|
   | Create a thread | Open the app; add a project on a temp directory; open the thread picker from the sidebar "Add thread" control; create a Pretty thread | The thread row shows; status goes to idle |
   | Message a Pretty thread | Type a message; send | The user bubble and the fake reply show once; the spinner stops; a reload shows the same history once |
   | Coordinator `spawn_agent` | Open the coordinator; let the fake coordinator call `spawn_agent` (scripted in the fake CLI), or call the same REST route with a thread key | A worker thread shows; its Finished notice reaches the coordinator once |
   | Usage flyout | Open the usage ring flyout on desktop width and on phone width | The cards render; an account with a failed read shows its state (W1-H); no console error |
   | Previews tab | Open the Previews tab of a thread | The tab loads through the plugin SDK; no deprecation warning after W3-F |
   | Command palette | Open the palette; type part of the thread label; press Enter | The thread opens; from Wave 2 the URL is `/p/<project>/t/<thread>` and Back returns |
   | Restart | Stop the isolated daemon during a fake turn; start it again | The status is right; no thread is "working" with a dead process and no explanation; pending notices arrive once |

   Save one screenshot per flow in the scratch folder and list the paths in the wave report.
7. Wave-specific checks:
   - Wave 1: `curl --compressed` shows `Content-Encoding`; an absolute read of `<fake home>/.dispatch/access-token` answers 403; `DISPATCH_BIND=127.0.0.1` binds to that address; a second build keeps the chunks of the first build.
   - Wave 2: a model switch keeps every other config key (read through the diagnostics route); `./bin/dispatch doctor <id>` prints an explanation (point the CLI at the isolated port); paging a 100 MB transcript does not stop a second thread's socket.
   - Wave 3: reload during and after a fake turn shows the right spinner; a fake ACP thread shows history after a restart; a thread in a new worktree shows its diff and discards a file.
8. Stop the isolated daemon. Write the wave report: counts, numbers of 1A.3, screenshots, open issues.

---

## 2. Coverage map

Every roadmap item has a home. Table rows outside the roadmap are placed where they are cheap, or listed in section 8.

| Roadmap item | Workstream |
|---|---|
| P1: Narrow store updates, memoized rows, composer split, memoized timeline | W1-F |
| P1: Compression for JSON and replays; bounded tail reads; quieter `terminal:activity` | W1-E |
| P1: Root error boundary; typed server events; delete dead code and unused dependencies | W1-G |
| P1: Stall watchdog; orphan-run cleanup at boot; idempotent message POST; watches fire on change only | W1-D |
| P1: Block secret reads; repair `network-access.md`; re-read `index.html` | W1-B (first two), W1-E (third) |
| P1: NodeNext, tests out of dist, ESLint | W1-A |
| P1: Command palette that opens threads | W1-G |
| Security scope from the owner: strict owner checks, evict-oldest limiter, `DISPATCH_BIND` | W1-B |
| Security scope from the owner: Doppler token only where needed; Cloudflare Access JWT | W1-C |
| P2: Typed thread config and a safe patch store | W2-A |
| P2: Async byte-range transcript reader | W2-B |
| P2: Delivery outbox | W2-C |
| P2: "Why is this thread here" panel | W2-G |
| P2: Shared structured-transport core | W2-D |
| P2: Split the entry bundle; throttled markdown streaming | W2-E |
| P2: Attention queue; desktop URL routes | W2-F |
| P3: One status authority | W3-C |
| P3: Daemon message journal with sequences | W3-D |
| P3: `buildDaemon()` shared by tests | W3-A |
| P3: Split `SessionService` into five services | W3-B (the first of the five, `ConversationReader`, lands in W2-B) |
| P3: UI primitives and type and space tokens | W3-E |
| P3: Narrow plugin SDK | W3-F |
| P3: Diff review and worktrees per thread | W3-G |
| P3: One orchestrator model and one set of names | Deferred, section 7 |

Table rows that the roadmap does not name, placed in this program:

| Table row | Workstream |
|---|---|
| Top 15 #10 boot recovery: flag slept wakes, persist pending questions | W2-C |
| Reliability #7 second half: mark a watch fired after a successful delivery | W2-C |
| Daemon #4 typed event map on `IStructuredManager` | W2-D (map), W3-B (move raw listeners) |
| Performance #8 compact the structured ring, add a byte limit | W2-D |
| Performance #11 trim lifecycle rows every Nth insert; daemon #7 four indexes and WAL tuning | W1-E |
| Reliability #9 `./bin/dispatch doctor <thread>` | W2-G |
| Reliability #10 contract tests on recorded frames | W2-D (the fixtures that exist today) |
| Web #4 split the three core files | W1-F (`timeline/`), W2-F (mobile navigation hook), W3-C (`useStructuredChat` split) |
| Security: warn about a forwarder in `dispatch status` | W1-B |
| Visible name follows the coordinator name setting | W1-G |
| Owner request: Claude accounts with a 403 on usage and profile; back-off on 429 | W1-H |

---

## 3. Wave 1: quick wins and independent hardening

Base: `claude-resets` at the plan commit. Seven workstreams and one small one (W1-H). None changes `sessions/service.ts`.

### W1-A: Build health

**Covers:** top 15 #14; daemon roadmap #2.

**Owns**
- `packages/core/tsconfig.json`, new `packages/core/tsconfig.test.json`
- `packages/cli/tsconfig.json` (same change, if the package compiles with `tsc`)
- new `eslint.config.js` (repository root), root `package.json` (`scripts`, `devDependencies` only), `pnpm-lock.yaml`
- `packages/core/package.json` (`scripts` only), new `packages/core/scripts/strip-test-output.mjs`
- `packages/core/src/conversation/task-notification.test.ts` (import line 5), `packages/core/src/conversation/transcript.test.ts` (import line 2, five parameter types)
- Any other test file, for a type error that the new test type-check finds. One-line fixes only.

**Does not own:** `tsconfig.base.json` (the web package needs `bundler`).

**Design**
- Core and CLI override `module` and `moduleResolution` to `NodeNext`.
- The build config excludes `src/**/*.test.ts` and `src/**/*.fixture.ts` (confirm first that only tests import the fixtures).
- `tsconfig.test.json` has `noEmit: true` and includes `src` and `tests`. New script: `typecheck` = both configs.
- The build script does not delete `dist`. After `tsc`, `strip-test-output.mjs` removes `dist/**/*.test.{js,js.map,d.ts,d.ts.map}`.
  Reason: an update rebuilds under a live daemon; a wiped `dist` can break a lazy import.
- ESLint flat config with `typescript-eslint`, type-aware for `packages/core/src` and `packages/cli/src`:
  `@typescript-eslint/no-floating-promises` = error, `@typescript-eslint/no-misused-promises` = error,
  `no-empty` with `allowEmptyCatch: false` = warn.
- The 513 `catch {` sites are not edited in this wave (that would conflict with every other stream).
  The `lint` script uses `--max-warnings <count at merge>`. The count can only go down.
- If `no-floating-promises` reports errors in files that another Wave 1 stream owns, add a `void` operator only.
  Do this in a last commit, after the other streams merge (see 3.8).

**Interfaces produced**
- `pnpm -C packages/core run typecheck`, `pnpm run lint` (root). Later waves run both before they finish.

**Tests first**
- `packages/core/tests/build/no-tests-in-dist.test.ts`: reads `tsconfig.json`; asserts the `exclude` list holds the test and fixture globs.
- `packages/core/tests/build/nodenext.test.ts`: asserts `module` and `moduleResolution` are `NodeNext` in the core config.
- Keep `packages/core/tests/esm-import-extensions.test.ts` green.

**Acceptance**
- `npx tsc -p packages/core --noEmit` passes under NodeNext. A relative import with no `.js` fails the compile.
- A build in the worktree leaves zero `*.test.js` under `packages/core/dist`.
- `pnpm run lint` exits 0. The warning ceiling is written in `package.json`.
- The isolated daemon starts.

**Effort:** S. Risk: the first type-check of `tests/` can find many errors. If the count is over 150, land the
`tests/` check as a script that reports and does not block, and write the count in the hand-off.

---

### W1-B: Security boundaries

**Covers:** top 15 #11; security table rows "every local caller is the owner", "forwarder", "limiter", "`DISPATCH_BIND`";
the `network-access.md` repair.

**Owns**
- new `packages/core/src/files/secret-paths.ts` and its test
- `packages/core/src/routes/files.ts`: `resolveRead` (`:192-204`) and the `/read` handler (`:303-330`). Any other read route that calls `resolveRead`.
- `packages/core/src/routes/secrets.ts`: the `/:name/value` route (`:46`)
- `packages/core/src/routes/integrations.ts`: the `/export` route (`:46`)
- `packages/core/src/server-routes.ts`: the pair-code route (`:140-144`)
- `packages/core/src/auth/access-gate.ts`: the failure limiter only (`:290-312`)
- `packages/core/src/server.ts`: the listen block only (`:1186-1207`)
- `bin/dispatch`: `install` (pass `DISPATCH_BIND` into the plist as it does `PORT`) and `status` (print the bind address and the forwarder warning)
- `docs/network-access.md`, new `packages/core/tests/docs/no-conflict-markers.test.ts`

**Design**
1. **Deny-list.** `isSecretPath(realPath: string, roots: SecretRoots): boolean`.
   `SecretRoots = { home: string; dataDir: string }`, injected (tests use a temp dir).
   Denied under `dataDir`: `access-token`, `keys/`, the secrets config directory, `accounts.json`, `*.db`, `*.db-wal`, `*.db-shm`,
   the marketplace and installer state files that hold tokens (check each).
   Denied under `home`: `.ssh/`, `.aws/`, `.gnupg/`, `.config/gcloud/`, `.cloudflared/`, `.kube/`, `.docker/config.json`,
   `.netrc`, `.npmrc`, `.claude/.credentials.json`, `.codex/auth.json`, the OpenCode `auth.json`, `.config/gh/hosts.yml`.
   The check runs on the **real path** (after `fs.realpath`) so a symbolic link cannot go around it.
   It applies to every caller, the owner included. The answer is `403 { error: 'This path holds credentials. Dispatch does not serve it.' }`.
   Ordinary files in `dataDir` (role files, inbox, plugin files) stay readable.
2. **Strict owner.** Add `ownerOnlyStrict` to `GET /api/secrets/:name/value`, `GET /api/integrations/export`
   and `POST /api/access/pair-code`. The web page passes (`looksLikeBrowser`). A token or cookie caller passes.
   A local call with no credential gets the existing `auth_required` refusal. No CLI code calls these three routes (checked: `packages/cli/src`, `bin/`).
3. **Limiter.** Replace `failures.clear()` with eviction: first the oldest entries that are below `LOGIN_MAX_FAILURES`,
   then the oldest blocked entries, until the size is 1,000. A blocked caller stays blocked while a flood arrives.
4. **`DISPATCH_BIND`.** Unset: `server.listen(port)` as today. Set: `server.listen(port, host)` in both calls.
   Accept an IP literal (`net.isIP`) or `localhost`. Any other value stops the start with one clear error line.
   `dispatch status` prints "Listens on: all interfaces" or the address. It prints a warning when the daemon listens on all
   interfaces and no relay header was seen on a request whose Host was a loopback name through a proxy path
   (use the counter in `auth/no-credential-stats.ts` if it fits; otherwise print the static advice only).
5. **Doc.** Remove the marker at `docs/network-access.md:179` and the stale base block after it. Keep the current text above it.
   Add a `DISPATCH_BIND` section.

**Interfaces produced**
- `isSecretPath(realPath, roots)`; `defaultSecretRoots(dataDir): SecretRoots`. W3-G uses it for the diff route.
- Environment variable `DISPATCH_BIND`.

**Tests first**
- `secret-paths.test.ts`
  - "denies the access token, the keys folder and the database under the data dir"
  - "denies ~/.ssh, ~/.aws and the CLI credential files"
  - "allows an ordinary file in the data dir and a file in another repository"
- `routes/files.test.ts` (add)
  - "an absolute read of the access token answers 403" (owner principal and no-credential principal)
  - "a symbolic link that points at a secret answers 403"
  - "an absolute read of a file in another repository still answers 200" (the escape hatch stays)
- `routes/secrets.test.ts`, `routes/integrations.test.ts`, the pair-code test (add or extend)
  - "a call with no credential and no browser headers answers 401 auth_required"
  - "the web page (browser headers) gets the value" ; "a bearer token gets the value"
- `auth/access-gate.test.ts` (add)
  - "a blocked caller stays blocked after 1,001 other callers fail"
  - "the map never holds more than 1,000 entries"
- `tests/server/bind.test.ts`
  - "with DISPATCH_BIND=127.0.0.1 the server address is 127.0.0.1" ; "an invalid value rejects with a clear message" ; "unset gives the old call"
- `tests/docs/no-conflict-markers.test.ts`: no line in `docs/**/*.md` starts with `<<<<<<<`, `|||||||`, `=======` (alone) or `>>>>>>>`.

**Acceptance**
- All tests above pass. `route-policy-completeness.test.ts` passes.
- In the isolated instance: Settings shows a secret value, exports integrations and makes a pairing code from the browser.

**Effort:** S to M.

---

### W1-C: Doppler token scope and Cloudflare Access JWT

**Covers:** security table rows "every thread gets the full `DOPPLER_TOKEN`" and "Cloudflare Access is the only gate after allow-host".

**Owns**
- `packages/core/src/secrets/service.ts`, `packages/core/src/secrets/doppler.ts`, the Doppler MCP server entry file (find it from `dopplerMcpPath`)
- `packages/core/src/routes/secrets.ts`: `/status` and `/connection` only (`:17-25`)
- `packages/core/src/server.ts`: line `:919` (the secrets spread in `refreshPtyEnv`) and line `:864` (the `setAccountEnv` closure)
- new `packages/core/src/routes/thread-secrets.ts` (one route), mounted in `server-routes.ts` next to the terminals router (one line)
- new `packages/core/src/auth/cf-access.ts` and its test
- `packages/core/src/auth/known-hosts.ts`
- `packages/core/src/auth/access-gate.ts`: `isKnownLocalHost` (`:96-118`) and the `GateRequest` type and its builder only
- `packages/core/src/auth/access-api.ts`, `bin/dispatch` (`access cloudflare` subcommand only), `packages/cli/src/index.ts` if the subcommand lives there
- `packages/web/src/components/settings/` the Secrets section file; `packages/web/src/stores/secrets.ts`; `packages/web/src/api/client.ts` (the secrets functions and one new function)
- The thread settings menu component: one toggle row (find the component that shows the alerts and auto-archive switches)
- `docs/network-access.md` (new "Cloudflare Access verification" section; coordinate with W1-B, see 3.8), new `docs/secrets.md` section "Token scope"

**Design: Doppler**

Three users of the token exist today:
1. The Doppler MCP server child. It reads `${DOPPLER_TOKEN}` from the CLI's environment (`secrets/service.ts:204`, `:247`).
2. A `doppler run` command that an agent types. The prompt says the token is set (`secrets/service.ts:230`).
3. The integration launcher. It reads the saved connection from the secrets directory (`integrations/launcher.ts:64`). It does not need the environment.

Changes:
- The Doppler MCP server takes `--secrets-dir <dir>` and reads the saved connection file (mode 0600), as the launcher does.
  The MCP config files then carry no `${DOPPLER_TOKEN}` reference. User 1 no longer needs the environment.
- `SecretsService` gets a saved field `tokenScope: 'all' | 'opted-in'`.
  - A saved connection with no field reads as `'all'`. An existing install behaves exactly as today.
  - A connection that is made new (no token saved before) is written with `'opted-in'`.
- `getSpawnEnv()` splits:
  - `getBaseSpawnEnv(): Record<string, string>` gives `DOPPLER_PROJECT`, `DOPPLER_CONFIG`, `DOPPLER_READ_ONLY`, and the token **only** when the scope is `'all'`.
  - `getThreadTokenEnv(config: { secretsEnv?: boolean }): Record<string, string>` gives `{ DOPPLER_TOKEN }` when the scope is `'opted-in'` and `config.secretsEnv === true`; otherwise `{}`.
- `server.ts:919` uses `getBaseSpawnEnv()`. The closure at `server.ts:864` becomes
  `(type, config) => ({ ...accounts.spawnEnv(type, config), ...secretsService.getThreadTokenEnv(config) })`.
  No change in `sessions/service.ts`.
- The prompt text no longer says "DOPPLER_TOKEN is already set". It says: use the Doppler MCP tools; if `$DOPPLER_TOKEN`
  is set in the shell, prefer `doppler run`.
- `PUT /api/terminals/:id/secrets-env { enabled: boolean }`, `ownerOnlyStrict`. It reads the config fresh, changes one key
  and writes, inside one SQLite transaction. It takes effect at the next spawn of the thread; the response says so.
  W2-A later moves this write to the config store.
- Settings, Secrets: one select, "Give the Doppler token to: every thread / only threads that I turn on".
  With scope `'all'`, show one line of advice with a button that changes the scope. Thread settings: one switch,
  "Doppler token in this thread's shell", shown only when the scope is `'opted-in'`. Phosphor icons only.

Limit to state in the docs: the saved connection file is readable by any program that runs as the same macOS user.
The change removes the token from each process environment and from the `ps` listing. It is not an operating-system boundary.

Migration (write it in `docs/secrets.md` and in the release note):
- An existing install keeps `'all'`. Nothing changes until the owner changes the select.
- After the change to `'opted-in'`, a thread that runs `doppler run` in its shell needs the thread switch and a restart of the thread.
- The Doppler MCP tools and all integrations work in both scopes with no action.

**Design: Cloudflare Access**

- The access file (`known-hosts.ts`, `AccessFile`) gets an optional object: `cloudflareAccess?: { teamDomain: string; aud: string }`.
- Unset: no code path changes. Test this.
- Set: a request whose Host is in `allowedHosts` counts as a known local host **only** when it carries a valid
  `Cf-Access-Jwt-Assertion`. With a missing or invalid assertion the host is not vouched for, and the request falls to the
  normal sign-in (cookie or token). The gate never answers a hard 403 for this reason.
- `createCfAccessVerifier(opts: { teamDomain: string; aud: string; fetchJwks?: (url: string) => Promise<Jwks>; now?: () => number }): { verify(jwt: string): Promise<CfAccessResult> }`
  with `CfAccessResult = { ok: true; email?: string } | { ok: false; reason: 'malformed' | 'alg' | 'kid' | 'signature' | 'aud' | 'iss' | 'expired' | 'not-yet-valid' | 'jwks-unavailable' }`.
  - RS256 only. Verify with `node:crypto` (`createPublicKey({ key: jwk, format: 'jwk' })`). No new dependency.
  - Keys from `https://<teamDomain>/cdn-cgi/access/certs`, cached by `kid`. An unknown `kid` causes one refetch, at most once per 60 s.
  - Check `aud` (string or array), `iss === https://<teamDomain>`, `exp`, `nbf` with 60 s of clock tolerance.
  - A key fetch failure with no cached key gives `jwks-unavailable`: fail closed (sign-in page), log one rate-limited line.
- `GateRequest` gets `cfAccessJwt?: string`. Confirm that the WebSocket upgrade path builds the same request shape.
- CLI: `./bin/dispatch access cloudflare --team-domain <name>.cloudflareaccess.com --aud <tag>` and `--off`.
  It validates the two values. `dispatch access` already refuses inside a thread; keep that.
- `dispatch status` prints "Cloudflare Access check: on (team …)" or "off". When `allowedHosts` is not empty and the check is off, it prints one advice line.

**Interfaces produced**
- `SecretsService.getBaseSpawnEnv()`, `getThreadTokenEnv(config)`, `status().tokenScope`, `setTokenScope(scope)`.
- Thread config key `secretsEnv?: boolean` (W2-A adds it to the typed config).
- `AccessConfig.cloudflareAccess(): { teamDomain: string; aud: string } | null`.

**Tests first**
- `secrets/service.test.ts` (add)
  - "a saved connection with no tokenScope reads as all and getBaseSpawnEnv carries the token" (today's behaviour is pinned)
  - "a new connection is saved as opted-in"
  - "with opted-in, getBaseSpawnEnv has no DOPPLER_TOKEN"
  - "getThreadTokenEnv gives the token only for secretsEnv true and scope opted-in"
  - "the Claude and Codex MCP configs hold no ${DOPPLER_TOKEN} reference and pass --secrets-dir"
  - "the system prompt does not claim that the token is set"
- Doppler MCP entry test: "with --secrets-dir it lists secret names with no DOPPLER_TOKEN in the environment".
- `routes/thread-secrets.test.ts`: "changes only secretsEnv and keeps every other config key" ; "refuses a call with no credential and no browser headers".
- `auth/cf-access.test.ts` (keys made in the test with `generateKeyPairSync`)
  - "accepts a valid token" ; "rejects a wrong aud" ; "rejects a wrong iss" ; "rejects an expired token" ; "rejects alg none and HS256"
  - "refetches once for an unknown kid, then rejects" ; "fails closed when the key fetch fails and no key is cached"
- `auth/access-gate.test.ts` (add)
  - "with no cloudflareAccess config an allow-listed host is trusted as before"
  - "with the config set, an allow-listed host with no assertion gets the sign-in page"
  - "with the config set and a valid assertion, the host is trusted"
  - "a loopback host is not affected by the config"
- Web: `SecretsSection.test.tsx` "shows the scope select and saves it" ; thread settings test "the switch is hidden when the scope is all".

**Acceptance**
- All tests pass. In the isolated instance with a fake Doppler client: the MCP tools list names in both scopes.
- The migration text is in `docs/secrets.md`.

**Effort:** M.

---

### W1-D: Reliability quick wins

**Covers:** top 15 #5 and part of #10; reliability table #2, #3 (orphan runs), #5, #7 (first half).

**Owns**
- new `packages/core/src/runtime/stall-watchdog.ts` and its test
- `packages/core/src/structured/manager.ts` (`IStructuredManager` gets one method), `manager.ts`, `codex-manager.ts`, `grok-manager.ts`: one field and one stamp per manager, at the place where a frame enters the ring
- `packages/core/src/pty/manager.ts`: one map and one method
- `packages/core/src/server.ts`: the tick body (`:1316-1322`) and the boot `finally` block (`:1291-1303`)
- `packages/core/src/status/service.ts`: line `:437` only
- `packages/core/src/agents/service.ts` (one new method), `packages/core/src/db/agents.ts` (one new query)
- `packages/core/src/routes/terminals.ts`: the message route (`:154` to its end) and one new route `GET /terminals/stalls`
- new `packages/core/src/http/idempotency.ts` and its test
- `packages/web/src/stores/threadStatus.ts`, new `packages/web/src/components/common/StallBadge.tsx`, `packages/web/src/lib/resync.ts` (one call)
- `packages/web/src/api/client.ts`: the message send functions only, and one new function `listStalls`

**Design**
1. **Stall watchdog.**
   `class StallWatchdog { constructor(deps: StallDeps); tick(): void; get(terminalId: string): StallState | null; all(): StallState[] }`
   `StallDeps = { listWorking(): { id: string }[]; lastFrameAt(id: string): number | undefined; now(): number; thresholdMs: number; onChange(s: StallChange): void }`
   `StallState = { terminalId: string; stalledSince: number; lastFrameAt: number | null }` ; `StallChange = { terminalId: string; stalledSince: number | null }`.
   - `listWorking` reads terminals with status `working` that are not archived.
   - `lastFrameAt` asks the structured manager of the thread, then the PTY manager.
     `IStructuredManager.lastFrameAt(terminalId: string): number | undefined` ; `PtyManager.lastOutputAt(id: string): number | undefined`.
   - Threshold: 10 minutes; `DISPATCH_STALL_MINUTES` overrides it.
   - Sleep guard: when the gap between two ticks is over 90 s, the Mac slept. That tick sets every baseline to "now" and flags nothing.
   - The watchdog only flags. It never kills, never changes the status and never sends a message to the thread.
   - `onChange` broadcasts `{ type: 'terminal:stall', terminalId, stalledSince: string | null }` and writes one `lifecycle_events` row (`stall.flagged` / `stall.cleared`).
   - It is called from the existing 30 s tick in `server.ts:1316`, after `processDueRuns`, in its own `try`. No new timer.
   - `GET /api/terminals/stalls` returns `all()`. The client calls it once on connect and reconnect (`lib/resync.ts`).
   - Web: `useThreadStatus` gets `stalls: Record<string, number>`. `StallBadge({ terminalId })` shows a Phosphor `HourglassMedium`
     icon with the title "No output for N min. The thread can still be at work." Neutral colour. The integrator mounts it (see 3.8).
2. **Orphan runs at boot.** `AgentService.reconcileRunsAtBoot(isAlive: (terminalId: string) => boolean): AgentRun[]`.
   For each run in `queued/starting/working/needs_input` (`agentsDb.listOpenRuns`, new): when `terminal_id` is null or the
   terminal is not alive, close the run with the error text "The daemon restarted during this run." and broadcast the update.
   - It runs in the boot `finally` block after `reconcileProcesses`, so a kickstarted thread is alive and its run stays open.
   - A role run is closed without a retry and without a change to `consecutive_failures`. Check the run status enum first and
     use the existing "interrupted" or "failed" value that fits; do not call `superviseFinalizedRun`.
3. **Idempotent message POST.** The client sends an `Idempotency-Key` header (a UUID per send).
   `createIdempotencyCache(opts?: { ttlMs?: number; max?: number; now?: () => number }): { seen(scope: string, key: string): CachedResponse | null; remember(scope, key, r: CachedResponse): void; begin(scope, key): boolean }`.
   - Scope = terminal id. TTL 10 minutes, 500 keys per scope, in memory.
   - A second request with the same key gets the first response with `duplicate: true` and nothing is delivered.
   - A second request that arrives while the first is in flight gets `409 { error: 'in_flight' }`.
   - A request with no header behaves as today. The web client retries once on a network error with the same key.
   - The cache does not survive a restart. W3-D makes it durable with the journal.
4. **Watches fire on a change only.** At `status/service.ts:437`, call `onWatchStatus` only when the new terminal status
   differs from `prior` (`:425`). A second `idle` notification no longer burns a one-shot watch or wakes a watcher twice.
   "Mark fired after a successful delivery" waits for the outbox (W2-C).

**Interfaces produced**
- `IStructuredManager.lastFrameAt`, `PtyManager.lastOutputAt` (W2-D keeps the first in the shared core).
- Events `terminal:stall`; route `GET /api/terminals/stalls`; `StallWatchdog.get` (W2-G reads it).
- `AgentService.reconcileRunsAtBoot` (W3-B moves the call into `BootRecovery`).
- Header `Idempotency-Key` on `POST /api/terminals/:id/message`.

**Tests first**
- `runtime/stall-watchdog.test.ts` (fake clock)
  - "flags a working thread with no frame for longer than the threshold" ; "does not flag an idle thread"
  - "clears the flag when a frame arrives" ; "emits one change per edge, not one per tick"
  - "a tick gap over 90 s resets the baselines and flags nothing" ; "never calls a kill, stop or status function" (the deps hold none; assert the type)
- Manager tests (one per manager): "lastFrameAt moves when a frame arrives".
- `agents/service.test.ts` (add): "a working run whose terminal is gone is closed at boot and the schedule is due again" ;
  "a run whose terminal is alive stays open" ; "a role run is closed with no retry run".
- `http/idempotency.test.ts`: "the same key returns the first response" ; "another scope is independent" ; "a key expires after the TTL" ; "the oldest key is evicted at the limit".
- `routes/terminals.test.ts` (add): "two POSTs with one key deliver once" ; "a POST with no key delivers every time".
- `status/service.test.ts` (add): "a repeated idle status does not call onWatchStatus again" ; "working then idle calls it once".
  Existing `watch-dispatcher` tests stay green.
- Web: `threadStatus.test.ts` "a terminal:stall event sets and clears the entry" ; `StallBadge.test.tsx` "renders nothing with no stall".

**Acceptance:** all tests pass; the isolated instance shows a stall flag for a fake stuck thread after the threshold (use `DISPATCH_STALL_MINUTES=1`).

**Effort:** M.

---

### W1-E: Daemon performance and network quick wins

**Covers:** top 15 #13; performance table #6, #7, #11 (trim), #13; daemon roadmap #7 (indexes, WAL tuning); the `index.html` item.

**Owns**
- new `packages/core/src/http/compress.ts` and its test
- `packages/core/src/ws/client-wss.ts`
- `packages/core/src/server.ts`: the body-parser and middleware lines of `createApp` and `startServer` (one `app.use` in each), the static block (`:1050-1075`), the three `createClientWss` calls (`:600-602`)
- new `packages/core/src/sessions/tail-read.ts` and its test; `packages/core/src/sessions/cc-sessions.ts` (`:105-160`, `:246-252`)
- `packages/core/src/terminal-monitor.ts`
- `packages/core/src/db/connection.ts`, `packages/core/src/db/schema.ts` (one appended migration), `packages/core/src/runtime/diagnostics.ts`
- `packages/core/src/web-assets.ts` (new index provider)
- `packages/web/vite.config.ts` (`build` block only), new `packages/web/scripts/prune-assets.mjs`, `packages/web/package.json` (`build` script only)

**Design**
1. **JSON compression.** `jsonCompression(opts?: { thresholdBytes?: number }): express.RequestHandler`.
   It wraps `res.json`. A body over 1 KB is sent with brotli (quality 4) or gzip, chosen by `pickEncoding` (`web-assets.ts:30`).
   It sets `Vary: Accept-Encoding`. It skips a response that has `Cache-Control: no-store` (secret values) and any stream response.
2. **WebSocket compression.** `createClientWss(maxPayload, opts?: { deflate?: boolean })`. The structured and events servers use
   `perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 }`.
   The terminal server stays uncompressed (binary PTY output, latency). `DISPATCH_WS_DEFLATE=0` turns it off.
3. **Bounded tail reads.** `readTail(file: string, maxBytes: number): { text: string; truncatedHead: boolean }`
   (open, read from the end, drop the first partial line).
   - `findNewestUnresolvedUserUuid`: read 256 KB; widen by ×4 up to 16 MB until the answer is found.
   - `readSessionBackfill`: read 2 MB; widen until `limit` events are found or the old 16 MB cap is reached.
   - `readTerminalTokenUsage`: `TokenTotalsCache` keyed by file path; it keeps the size and the totals, and sums only the new bytes. A smaller file resets it.
4. **Quieter activity.** `TerminalMonitor.broadcast` sends `terminal:activity` only when one field of the payload differs from the last payload sent for that terminal.
5. **Data layer.** Migration `w1e-indexes`: indexes on `terminals(session_id)`, `terminals(status)`, `agent_runs(terminal_id)`, `agent_runs(schedule_id)`.
   `connection.ts`: `synchronous = NORMAL`, `busy_timeout = 5000` (after the WAL line at `:43`; check the exclusive-lock path at `:26`).
   `runtime/diagnostics.ts:8`: run the trim `DELETE` on every 50th insert per terminal, not on every insert.
6. **`index.html`.** `createIndexProvider(file: string, basePath: string): () => string`. On each request it does one `fs.statSync`;
   when the mtime or size changed it reads and transforms the file again. A read error keeps the last good copy.
7. **Keep previous assets.** `vite.config.ts`: `build.emptyOutDir: false`, `build.manifest: true`.
   `prune-assets.mjs` runs after the build: it keeps the files of the current manifest and of the previous manifest
   (saved as `dist/.vite/manifest.prev.json`) and removes all other files in `dist/assets`. An open tab on the last build keeps its chunks.

**Interfaces produced**
- `jsonCompression()`, `readTail()`, `createIndexProvider()`, `createClientWss(maxPayload, { deflate })`.
- `vite.config.ts` `build` block: W2-E adds `rollupOptions` to it.

**Tests first**
- `http/compress.test.ts`: "a 5 KB JSON body is sent with br when the client accepts it" ; "a 200-byte body is not compressed" ;
  "a no-store response is not compressed" ; "the decoded body equals the object".
- `ws/client-wss.test.ts`: "the structured server negotiates permessage-deflate" ; "the terminal server does not" ; "DISPATCH_WS_DEFLATE=0 turns it off".
- `sessions/tail-read.test.ts`: "returns whole lines only" ; "truncatedHead is false for a small file" ; "a multi-byte character at the cut is not broken".
- `sessions/cc-sessions.test.ts` (add): "findNewestUnresolvedUserUuid gives the same answer as the full read on the fixture" ;
  "it reads at most 256 KB when the answer is in the tail" (spy on `fs.readSync` byte counts) ;
  "token totals after an append equal the totals of a full read" ; "backfill returns the same events as before for a file under 2 MB".
- `terminal-monitor.test.ts` (add): "two equal updates send one event" ; "a model change sends an event".
- `db/connection.test.ts` (add): "synchronous is NORMAL and busy_timeout is 5000". `db/schema.test.ts` (add): "the four indexes exist".
- `runtime/diagnostics.test.ts` (add): "the table holds at most 200 + 50 rows per terminal" ; "the trim runs once per 50 inserts".
- `web-assets.test.ts` (add): "the provider returns new content after the file changes" ; "it keeps the last copy when the file is missing".
- `packages/web/scripts/prune-assets.test.mjs` (node test or vitest): "keeps current and previous build files, removes older files".

**Acceptance:** all tests pass; in the isolated instance `curl --compressed` on `/conversation` shows a `Content-Encoding` header.

**Effort:** M.

---

### W1-F: Web render performance

**Covers:** top 15 #4 and part of #7; performance table #2, #3; web table #4 (the `timeline/` module).

**Owns**
- `packages/web/src/stores/tabs.ts`: `applyEvent` only (`:272-286`)
- new `packages/web/src/stores/tabsSelectors.ts` and its test
- `packages/web/src/components/sidebar/ProjectSidebar.tsx`, `ProjectCard.tsx`
- `packages/web/src/components/panes/GroupedTabBar.tsx`, `PaneFrame.tsx`, `TabActivityIndicator.tsx`
- `packages/web/src/components/mobile/AllThreadsView.tsx`; `MobileApp.tsx` line `:97` only
- `packages/web/src/components/overseer/store.ts` lines `:817`, `:846`, `:899` only
- `packages/web/src/components/tabs/chat/ChatView.tsx`, new `chat/Composer.tsx`, new `chat/timeline/` folder

**Design**
1. `applyEvent` for `terminal:status` and `terminal:exit`: find the one project that holds the terminal. When the status is
   equal, change nothing. Otherwise replace that one array and that one row. All other arrays keep their identity.
2. Selector hooks (each uses a stable selector and shallow equality):
   `useProjectTabs(projectId: string): Terminal[]` ; `useTerminal(id: string): Terminal | undefined` ;
   `useTerminalStatus(id: string): Terminal['status'] | undefined` ; `useProjectIndicator(projectId: string): 'needs_input' | 'error' | 'working' | 'idle'` ;
   `useTerminalProjectId(id: string): string | undefined`.
3. Replace `useTabs((s) => s.byProject)` at the 13 live sites listed above with the narrow hook that fits.
   A component that really needs all projects keeps the full selector and says why in a comment.
4. `React.memo` on `ProjectCard` and on the thread row component inside it. Props are ids and primitives.
5. `Composer` owns the draft state (`useDraft`, `ChatView.tsx:134`), staged images and the send key handling.
   A key press re-renders `Composer` only.
6. Move `renderTimeline` (`ChatView.tsx:674`) and the leaf components (`:949-1351`) to `chat/timeline/`. This is a move-only commit.
   `ChatView.tsx` re-exports every name that other files import (the Control Plane timeline and Chat use them).
7. `ChatView` calls `renderTimeline` inside `useMemo` keyed by the items array, the page boundaries and the callbacks (stable through `useCallback`).
   Leaf rows are `React.memo` with the item as the key prop.

**Interfaces produced**
- The five selector hooks. W2-F and W1-G (palette) may read them after the merge.
- `chat/timeline/index.ts` exports `renderTimeline` and the leaf components. `Composer` props:
  `{ terminalId: string; disabled: boolean; onSend(content: string | ContentBlock[]): void; slash?: SlashMenuProps }` (match what `ChatView` passes today).

**Tests first**
- `stores/tabs.test.ts` (add): "a status event changes only the array of the project that holds the terminal (identity check)" ;
  "an equal status changes nothing (the state object is the same)".
- `stores/tabsSelectors.test.ts`: "useProjectTabs for project B does not notify when a thread in project A changes".
- `sidebar/ProjectSidebar.test.tsx` (add): "a status event for project A does not render the ProjectCard of project B" (render counter through a mock or `React.Profiler`).
- `chat/Composer.test.tsx`: "typing does not call renderTimeline" (spy) ; "Enter with the send modifier calls onSend and clears the draft".
- `chat/ChatView.test.tsx`: all existing tests stay green; add "the timeline node is reused between two renders with equal items".
- `lib/noAskStrip.test.ts` stays green.

**Acceptance:** all web tests pass; with 30 fake working threads the React Profiler shows no `ProjectCard` commit for an unrelated status event (write the numbers in the hand-off).

**Effort:** M.

---

### W1-G: Web safety, cleanup, palette and name

**Covers:** top 15 #9 (palette), #12, #15; web table #1, #2; product table #1; the coordinator name.

**Owns**
- new `packages/web/src/components/common/ErrorBoundary.tsx` and its test; `packages/web/src/main.tsx`; `packages/web/src/App.tsx`
- `packages/web/src/api/events-socket.ts`, new `packages/web/src/api/server-events.ts`; new `packages/core/src/ws/server-events.ts` (types only, no import)
- The 12 stores' `applyEvent` signatures, **type annotations only** (no logic change). `stores/tabs.ts`: the signature line and `tabLabel` (`:60-63`).
  `stores/threadStatus.ts` belongs to W1-D: W1-G leaves it and the integrator applies the type there.
- Deletions: `packages/web/src/components/board/**`, `components/overseer/components/DelegateModal.tsx`, `components/layout/TabBar.tsx`,
  the unused scenario exports of `components/overseer/data.ts`, `components/overseer/ledger-fixture.ts` (only if no importer), `lib/utils.ts`
- `packages/web/src/stores/ui.ts`: the `View` type and `setView` (`:8`, `:64`) only
- `packages/web/package.json` (`dependencies` only), `pnpm-lock.yaml`
- `packages/web/src/components/CommandPalette.tsx` and its test; new `packages/web/src/lib/fuzzy.ts`
- Any component that prints the literal "Control Plane" as a visible label where the user-chosen name must show

**Design**
1. **Error boundary.** `ErrorBoundary({ scope: string; fallback?: (p: { error: Error; reset(): void }) => ReactNode; children })`.
   - Root boundary in `main.tsx`. One boundary around each view in `App.tsx` and around the phone leaf.
   - Default fallback: a Phosphor `WarningCircle`, one sentence, a "Reload" button, a "Try again" button (`reset`), a "Copy details" button.
   - `componentDidCatch` logs the scope and the error. No network call.
2. **Typed events.** `ServerEvent` becomes a discriminated union. `packages/core/src/ws/server-events.ts` is the definition.
   `packages/web/src/api/server-events.ts` re-exports it by a type-only relative import; if the web `tsconfig` refuses the path,
   keep a copy and add the parity test below.
   - Members: every event type that a web store reads today (list them by a search of `e.type ===` in `packages/web/src`), plus
     `UnknownServerEvent = { type: string; [k: string]: unknown }` as the last member for plugin events.
   - `parseServerEvent(raw: string): ServerEvent | null`: the JSON must be an object with a string `type`. For a known type, the
     required fields must have the right primitive type. A bad frame is dropped with one `console.warn` per type.
   - The core broadcaster stays untyped in this wave. W3-A types `broadcast()`.
3. **Dead code.** Delete the files above. Before each deletion, search for importers in source **and tests**.
   Keep `CANNED`, `btn`, `mission`, `outc`, `th` in `overseer/data.ts`. Keep the stored-view fallback: a saved `'board'` value loads as `'workspace'`.
   Remove `lucide-react`, `clsx`, `tailwind-merge`, `class-variance-authority`. The daemon-side board state is not touched here (W3-B decides).
   Write the count of deleted lines in the hand-off.
4. **Palette.** Rows: projects (open), threads of all projects with a status dot (open), "New thread in <project>" (opens the
   thread picker through `stores/pickerRequest.ts`; it never creates a thread directly), actions for the active thread
   (stop, restart, archive; archive asks for confirmation), then the views, settings and plugin commands of today.
   - `fuzzyScore(needle: string, text: string): number | null` (subsequence match; word-start and adjacency bonuses).
   - Order with an empty query: needs input, error, working, then most recent activity.
   - Keys: Up, Down, Enter, Escape. `role="listbox"` and `aria-activedescendant`.
   - Opening a thread uses `useUI.getState().requestOpenThread` (W2-F replaces this with `navigate`).
5. **Name.** `tabLabel` returns `useSettings.getState().coordinatorName.trim() || 'Control Plane'`. Components use `useDispatchName()`.
   The Settings group title that holds the name field keeps its text.

**Interfaces produced**
- `ErrorBoundary`; `ServerEvent` union, `parseServerEvent`, `EventOf<'terminal:status'>` helper type; `fuzzyScore`.

**Tests first**
- `common/ErrorBoundary.test.tsx`: "shows the fallback when a child throws" ; "Try again renders the child again" ; "a throw in one view leaves the app shell on screen".
- `api/server-events.test.ts`: "a terminal:status frame with no terminalId is dropped" ; "an unknown type passes as UnknownServerEvent" ; "a non-object frame is dropped".
- `packages/core/tests/ws/server-events-parity.test.ts` (only if a copy is used): "the web file and the core file list the same event types".
- `stores/ui.test.ts` (add): "a saved board view loads as workspace".
- `CommandPalette.test.tsx`: "typing part of a thread label lists the thread with its project" ; "Enter opens the thread" ;
  "threads that need input come first with an empty query" ; "New thread opens the picker and creates nothing" (assert no API call) ;
  "the virtual tab row shows the coordinator name from settings".
- `lib/fuzzy.test.ts`: "matches a subsequence" ; "ranks a word-start match above a mid-word match" ; "returns null with no match".
- `stores/tabs.test.ts` (add): "tabLabel of the virtual tab returns the saved coordinator name".

**Acceptance:** all web tests pass; `pnpm -C packages/web exec tsc --noEmit` passes; a build in the worktree works with the four dependencies removed.

**Effort:** M.

---

### W1-H: Claude accounts whose usage or profile read answers 403 (small)

**Covers:** an owner request of 2026-11-09. Two saved Claude accounts on the live install (ids `fce43419`, `d35c27aa`) get HTTP 403 on the usage and profile reads.

**What the code shows (checked; the live tokens were not read)**
- A saved Claude account holds one field for its login: `token` (`packages/core/src/auth/accounts.ts:18`). It has no refresh token and no expiry time.
- The token comes from the headless `claude setup-token` flow (`accounts.ts:5`, `:249-262`; `auth/claude-login.ts:204`).
- The code already expects the failure: "An added account's token may only run a model" (`limits/gauge.ts:436`). On a failed read it backs off that account and runs a tiny turn as it (`gauge.ts:437-438`).
- The reader returns only `true` or `false` (`limits/claude-usage.ts:209-216`). A 401, a 403, a 429 and a network error look the same to the gauge and to the UI.
- The `cli` account has no back-off after a failed read (`gauge.ts:437` excludes it): it reads again every 2 minutes (`gauge.ts:58`), also after a 429.
- The accounts route asks for a failed profile again every 2 minutes (`routes/accounts.ts:22`, `:49`).

**Most likely cause:** the saved token has a scope for model use only, and the usage and profile endpoints refuse it with 403.
An expired token is the second candidate; that case usually answers 401, and Dispatch has no refresh token for a saved account in any case.
The workstream must confirm the cause before it writes the fix (step 1).

**Owns**
- `packages/core/src/limits/claude-usage.ts`, `packages/core/src/limits/gauge.ts` (the Claude read block `:424-441` and the back-off maps)
- `packages/core/src/auth/accounts.ts`, `packages/core/src/routes/accounts.ts`, `packages/core/src/auth/claude-login.ts` (read; change only if step 1 shows a stored refresh token is possible)
- `packages/web/src/components/settings/AccountsSection.tsx`, the account card in the usage flyout (`components/layout/UsageRings.tsx` or the card file it uses), `packages/web/src/stores/accounts.ts`, `packages/web/src/api/types.ts` (one field)

**Design**
1. **Diagnose first.** Add the failure reason to the log line: the HTTP status and the `error.type` and `error.message` fields of the answer body (never the token).
   The owner runs the isolated build against a copy of one saved token, or reads the live log after the release; the hand-off records the body for 403.
   Decide from the body: "scope" (the token cannot read usage), "expired or revoked" (a new sign-in repairs it), or another reason.
2. **A typed result.** `ClaudeUsageReader` returns `Promise<UsageReadResult>`:
   `{ ok: true } | { ok: false; reason: 'no-token' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'server' | 'network'; status?: number; retryAfterMs?: number }`.
   The boolean callers change to `.ok`.
3. **Account state.** The gauge keeps `usageAccess` per account: `'ok' | 'sign-in-needed' | 'not-available' | 'rate-limited'`, with the time of the last good read.
   - 401, or a 403 whose body says expired or revoked: `sign-in-needed`.
   - 403 for scope: `not-available`. The fallback tiny turn stays the source of the figures for that account, as today.
   - The state is in the public account view (`PublicAccount.usageAccess`), never the token.
4. **No spend of the CLI's refresh token.** The `cli` account is still never refreshed by Dispatch (`claude-usage.ts:9-11`).
   - If step 1 shows that Dispatch can store a refresh token for a **saved** account, the store gets optional fields `refreshToken?` and `expiresAt?`,
     and `refreshSavedClaudeToken(account, deps): Promise<'refreshed' | 'failed'>` uses **that account's own** refresh token only, once per expiry, with the result saved atomically.
   - If no refresh token exists for a saved account (the code today), there is no refresh. The account shows "Sign in again".
5. **Back-off.** One helper for all failures: `nextReadAfter(result: UsageReadResult, failures: number, now: number): number`.
   - 429: wait for `Retry-After` when the header is present; otherwise 4, 8, 16, 32 and at most 60 minutes. It applies to the `cli` account too.
   - `forbidden` and `unauthorized`: 6 hours, and at once after the account's token changes or after the owner presses "Check again".
   - `server` and `network`: 4, 8, 16 and at most 30 minutes. A good read clears the count.
   - The profile retry in `routes/accounts.ts:22` uses the same state; it does not ask again every 2 minutes for a refused account.
   - The checks run inside the gauge loop that exists. No new timer.
6. **UI.** On the account card in the flyout and in Settings, Accounts:
   - `sign-in-needed`: the text "Sign in again to see usage for this account" and a "Sign in again" button that opens the existing Claude login flow for that account (the token is replaced in place; `addClaude` matches by account id, `accounts.ts:134-137`).
   - `not-available`: the text "This sign-in can run threads. It cannot read usage figures." and the figures from the tiny turn when they exist. No error colour.
   - `rate-limited`: the last figures with "Updated N min ago".
   - Phosphor icons only (`SignIn`, `Info`, `ClockCounterClockwise`).

**Interfaces produced:** `UsageReadResult`, `nextReadAfter`, `PublicAccount.usageAccess`.

**Tests first**
- `limits/claude-usage.test.ts` (add): "a 403 returns forbidden with the status" ; "a 401 returns unauthorized" ; "a 429 with Retry-After returns the wait in milliseconds" ;
  "the log line holds the status and the error type and never the token" ; "a 200 returns ok and records the windows as before".
- `limits/gauge.test.ts` (add; the 950 existing lines stay green)
  - "after a 429 the cli account is not read again before the wait ends" ; "the wait doubles on a second 429 and stops at 60 minutes" ; "a good read clears the wait"
  - "after a 403 a saved account is read again only after 6 hours or a token change" ; "the tiny turn still runs for a not-available account"
  - "two accounts back off independently"
- `auth/accounts.test.ts` (add): "the public view carries usageAccess and no token" ; if a refresh token is stored: "a refresh uses the saved account's own refresh token and never reads the CLI credential" (the CLI token source is a spy with zero calls).
- `routes/accounts.test.ts` (add): "a refused profile is not asked again within the back-off".
- Web: `AccountsSection.test.tsx` "an account with sign-in-needed shows the Sign in again button and it starts the login for that account id" ;
  "an account with not-available shows the note and no error style" ; the usage flyout test "a rate-limited account shows its last figures".

**Manual verification:** the isolated daemon with a fake usage endpoint (a local HTTP server given through the injected `fetch` or an env override that exists only for tests):
answer 403, 401, 429 with `Retry-After: 120`, then 200. Record the request times; take Playwright screenshots of the card in each state.

**Acceptance**
- The cause of the 403 is written in the hand-off with the response body (no token).
- No account is polled every 2 minutes after a 429 or a 403. The request log of the manual check shows the waits.
- No code path refreshes or rewrites the CLI's own credential (guard test above).
- Both live account states have a clear text and a next step on the card and in Settings.

**Effort:** S to M. If step 1 shows that the scope is the cause and the owner wants real usage figures for saved accounts,
a login with a wider scope for saved accounts is a new item (section 7, item 8).

---

### 3.8 Wave 1 integration

**Order**
1. W1-A (build health). Small, and every later merge is then checked under NodeNext.
2. W1-B, then W1-C (both touch `auth/access-gate.ts`, `bin/dispatch` and `docs/network-access.md`, in different regions).
3. W1-D.
4. W1-E.
5. W1-H (its files are its own; merge at any point after W1-A).
6. W1-G (deletions first make the W1-F merge smaller).
7. W1-F.
8. W1-A follow-up commit: run the linter on the merged tree, add `void` where `no-floating-promises` fails, set the warning ceiling.

**Integrator tasks after the merges**
- Mount `<StallBadge terminalId={…} />` in the thread row of `ProjectCard.tsx` and in the tab item of `GroupedTabBar.tsx`.
- Apply the `ServerEvent` type to `stores/threadStatus.ts`; add `terminal:stall` to the union.
- Add `jsonCompression()` before the routers in **both** `createApp` and `startServer` if W1-E wired only one.
- Run the integration test plan of section 1A.4 (full suites, type-check, linter, smoke start, end-to-end pass).

**Known conflict points**

| File | Streams | Rule |
|---|---|---|
| `packages/core/src/server.ts` | B (`:1186-1207`), C (`:864`, `:919`), D (`:1291-1303`, `:1316-1322`), E (`:600-602`, `:1050-1075`, one `app.use` in each root) | Regions do not overlap. Merge in the order above; each stream rebases before its merge. |
| `packages/core/src/auth/access-gate.ts` | B (limiter `:290-312`), C (`:96-118`, `GateRequest`) | Regions do not overlap. |
| `packages/core/src/routes/terminals.ts` | D (message route, new stalls route) | C puts its new route in a new file to stay out. |
| `packages/core/src/routes/secrets.ts` | B (`:46`), C (`:17-25`) | Regions do not overlap. |
| `packages/core/src/structured/*-manager.ts` | D only (one field, one method each) | Wave 2 (W2-D) restructures these files; D's change is small on purpose. |
| `packages/core/src/status/service.ts` | D (`:437`) | E must not adopt cached statements in this file. |
| `packages/core/src/db/schema.ts` | E (append) | Only E adds a migration in this wave. |
| `bin/dispatch`, `docs/network-access.md` | B, C | B merges first; C adds its own subcommand and its own section. |
| `packages/web/src/stores/tabs.ts` | F (`applyEvent`), G (`tabLabel`, signature type) | G merges first; F rebases. |
| `packages/web/src/api/client.ts` | C (secrets functions), D (message functions, `listStalls`) | Regions do not overlap. |
| `packages/web/src/api/types.ts` | H (one field on the account type) | Append only. |
| `packages/core/src/limits/*`, `auth/accounts.ts`, `routes/accounts.ts`, the usage flyout card | H only | No other Wave 1 stream owns these files. |
| `packages/web/src/components/panes/GroupedTabBar.tsx` | F | G must not edit the comment at `:115` when it deletes `layout/TabBar.tsx`; F updates the comment. |
| `packages/web/src/App.tsx`, `main.tsx` | G | F does not touch them. |
| `packages/web/vite.config.ts`, `packages/web/package.json` | E (`build`), G (`dependencies`) | Different keys. The lockfile conflicts: regenerate it with `pnpm install` at the merge. |
| `pnpm-lock.yaml` | A, G | Regenerate at each merge; never hand-merge. |

---

## 4. Wave 2: foundations

Base: the integrated Wave 1. Seven workstreams. `sessions/service.ts` has one main owner (W2-A) and two lent regions.

### W2-A: Typed thread config and the config store

**Covers:** top 15 #2; daemon roadmap #1; reliability cause E.

**Owns**
- new `packages/core/src/sessions/thread-config.ts` and its test
- `packages/core/src/db/terminals.ts` (`updateConfig`, the config part of the row mappers)
- `packages/core/src/sessions/service.ts`: all of it **except** lines `1046-1206` (lent to W2-B) and `1397-1464` (lent to W2-C)
- `packages/core/src/status/service.ts`: the three config writes (`:283`, `:356`, `:448`) and the reads next to them
- `packages/core/src/overseer/ledger-service.ts` (`:518`, `:530`), `packages/core/src/server-routes.ts` (`:203`), `packages/core/src/sessions/interim-recap.ts` (`:62`)
- `packages/core/src/routes/thread-secrets.ts` (from W1-C)
- `packages/core/src/sessions/thread-settings.ts`, `auto-archive.ts` where they build config objects

**Design**
- `interface TerminalConfig`: every known key, typed and optional. Build the key list from a search of `config.` and `cfg.`
  reads in `packages/core/src`. Group the keys with comments: spawn settings (model, effort, transport, accountId, skipPermissions),
  coordinator links (starter, role, mission, dependsOn), thread state (lastOutcome, kickedAt, interruptedAt, scheduledWake, pendingDeclaration),
  UI state (autoArchive, alerts, boardState), security (`secretsEnv`).
- Unknown keys are kept. `read` returns `TerminalConfig & Record<string, unknown>`; the store never drops a key that it does not know.
- `class ThreadConfigStore`
  - `constructor(db: Database.Database)`
  - `read(terminalId: string): TerminalConfig` (bad JSON reads as `{}` and logs once)
  - `patch(terminalId: string, patch: ConfigPatch | ((current: Readonly<TerminalConfig>) => ConfigPatch | null)): TerminalConfig`
    with `ConfigPatch = { [K in keyof TerminalConfig]?: TerminalConfig[K] | null }`. `null` or `undefined` deletes the key.
    The read, the merge and the write run in one SQLite transaction (`BEGIN IMMEDIATE`). A function patch that returns `null` writes nothing.
  - `transaction<T>(terminalId: string, fn: (tx: { get(): TerminalConfig; patch(p: ConfigPatch): void }) => T): T`
  - `initialize(terminalId: string, config: TerminalConfig): void` (creation only)
- Every one of the 33 `updateConfig` call sites becomes a `patch` that names only the keys it changes.
  A site that today reads the config at the top of a function and writes the whole object later is the bug class: do not carry the copy across calls.
- `SessionService.updateTab` (`service.ts:956-960`) takes a client config. It becomes a patch through an allow-list
  `CLIENT_SETTABLE_KEYS`. A key outside the list is ignored and logged. Check what the web client sends today
  (`api.updateTab` callers); if a caller relies on a whole-object replace to remove a key, it must send `null` for that key.
- `terminalsDb.updateConfig` is then renamed to an internal name and exported only for the store.
- `mergeConfig` (`service.ts:2364-2369`) is removed; its callers use the store.

**Interfaces produced**
- `TerminalConfig`, `ConfigPatch`, `ThreadConfigStore` (`read`, `patch`, `transaction`, `initialize`).
- `SessionService` gets the store by constructor option `configStore?: ThreadConfigStore` (default: built from `db`), so tests need no change.
- W2-B, W2-C and all of Wave 3 use the store. No code after this wave calls the raw write.

**Tests first**
- `sessions/thread-config.test.ts`
  - "patch changes only the named keys" ; "a null value deletes the key" ; "an unknown key in the row survives a patch"
  - "two patches from two stale copies both land" (the lost-update case: read A, read B, patch A.x, patch B.y, then both x and y are present)
  - "a function patch sees the value written by an earlier patch in the same tick"
  - "transaction rolls back every change when the callback throws" ; "bad JSON reads as an empty config and does not throw"
- `tests/sessions/no-raw-config-write.test.ts`: searches `packages/core/src` and asserts that no file outside `sessions/thread-config.ts`
  and `db/terminals.ts` calls the raw write function.
- `sessions/service.test.ts` (add): "updateTab with a partial config keeps the other keys" ; "updateTab ignores a key outside the allow-list".
- `status/service.test.ts` (add): "clearing the board override keeps a key written between the read and the write" (drive it with a patch inside a listener).
- All existing session, status, ledger and thread-settings tests stay green.

**Acceptance:** all core tests pass; the guard test passes; the isolated daemon starts and a model switch, an effort switch and an auto-archive switch each keep the other keys (check with the diagnostics route).

**Effort:** M to L (mechanical, wide).

---

### W2-B: Async byte-range transcript reader

**Covers:** top 15 #1; performance table #1; the first service of daemon roadmap #6 (`ConversationReader`).

**Owns**
- new `packages/core/src/conversation/line-index.ts`, new `packages/core/src/conversation/reader.ts`, and their tests
- `packages/core/src/sessions/service.ts` lines `1046-1206` (`historyOwnedByRest`, `historyRestPageable`, `getConversation`, `searchConversation`)
- `packages/core/src/routes/terminals.ts` lines `116-135` (the two conversation routes)
- Every other caller of `getConversation` or `searchConversation` (find them; MCP `read_thread` and Chat are likely): the `await` only

**Design**
- `class LineIndex`: for one file, the byte offset of each line start.
  - `static async open(file: string): Promise<LineIndex>` ; `async refresh(): Promise<void>` (reads only the bytes after the last indexed offset)
  - `lineCount: number` (complete lines only) ; `range(startLine: number, endLine: number): { offset: number; length: number }`
  - It reads in 1 MB chunks and yields to the event loop between chunks (`setImmediate`).
  - A smaller size or a new inode resets the index. An LRU keeps 8 indexes.
- `class ConversationReader`
  - `constructor(deps: { db: Database.Database; locate(terminalId: string): { file: string; parseLine: (line: string) => ConvItem[] } | null | 'unsupported' })`
  - `page(terminalId: string, opts: { since?: number; before?: number; beforeUuid?: string; limit?: number }): Promise<ConvPage>`
    with `ConvPage = { items: ConvItem[]; cursor: number; startLine: number; hasMore: boolean; unsupported?: boolean }` (the shape of today).
  - `search(terminalId: string, query: string, limit?: number): Promise<{ matches: { line: number; kind: string; snippet: string }[] }>`
- `page` computes the line window with the same four rules as today (`service.ts:1124-1140`), then reads one byte range and parses it.
  `beforeUuid` scans backward from the tail in 256 KB windows.
- `search` streams the file in chunks and yields between chunks.
- The source-tag merge (`service.ts:1147-1157`) moves into the reader unchanged.
- `SessionService.getConversation` and `searchConversation` stay as thin `async` delegates, so routes and tools keep one entry point.
- The response is byte-identical to today's for the same file and options. Line numbers keep their meaning.

**Interfaces produced**
- `ConversationReader.page`, `.search`; `LineIndex`. `SessionService.getConversation(...)` now returns a `Promise`.
- W3-B moves the delegate away. W3-D pages the journal next to this reader.

**Tests first**
- `conversation/line-index.test.ts`: "counts complete lines only (a half-written last line is not counted)" ; "refresh after an append reads only the new bytes" (spy on read positions) ;
  "a truncated file resets the index" ; "range returns the exact bytes of lines N to M" ; "multi-byte text keeps correct offsets".
- `conversation/reader.test.ts`
  - "parity: for the fixture transcript, each of the four window modes returns the same result as the old synchronous code" (the old function is copied into the test as the oracle)
  - "parity for a Codex rollout fixture" ; "beforeUuid finds an anchor that sits 300 KB before the end"
  - "page never calls fs.readFileSync" (spy) ; "a 20 MB generated file: no event-loop block over 50 ms during a page read" (`perf_hooks.monitorEventLoopDelay`)
  - "a thread with no transcript returns the empty page" ; "a shell thread returns unsupported"
- `routes/terminals.test.ts`: existing conversation tests stay green with the async handler; add "a reader error answers 500 with a client message, not a hung request".

**Acceptance:** all tests pass; write the measured page time and the largest loop delay for the 20 MB file in the hand-off.

**Effort:** M.

---

### W2-C: Delivery outbox and durable boot recovery

**Covers:** top 15 #3 and #10; reliability table #1, #3, #7 (second half); cause B.

**Owns**
- new `packages/core/src/delivery/outbox.ts`, new `packages/core/src/db/outbox.ts`, new `packages/core/src/db/pending-questions.ts`, and their tests
- `packages/core/src/db/schema.ts` (two appended migrations: `w2c-delivery-outbox`, `w2c-pending-questions`)
- `packages/core/src/sessions/service.ts` lines `1397-1464` (`notifyStarterOfAgent`, `deliverToStarter`)
- `packages/core/src/sessions/watch-dispatcher.ts`, `packages/core/src/db/watches.ts`
- `packages/core/src/server.ts`: the watch-deliver wiring (`:457`, `:692`) and three new lines of wiring (construct the outbox, subscribe it, boot flush)
- new `packages/core/src/sessions/boot-reconcile.ts` and its test

**Design**
- Table `delivery_outbox`: `id INTEGER PRIMARY KEY`, `target_terminal_id TEXT NOT NULL`, `source_terminal_id TEXT`, `kind TEXT NOT NULL`
  (`notice | watch | kickstart | question | lost-wake`), `body TEXT NOT NULL`, `dedup_key TEXT NOT NULL UNIQUE`,
  `state TEXT NOT NULL` (`pending | delivered | dropped`), `attempts INTEGER NOT NULL DEFAULT 0`, `last_error TEXT`,
  `created_at TEXT`, `delivered_at TEXT`. Index on `(target_terminal_id, state)`.
- `class DeliveryOutbox`
  - `constructor(deps: { db; deliver(targetId: string, body: string, kind: OutboxKind): DeliverResult; now?: () => number; maxAttempts?: number })`
    with `DeliverResult = 'delivered' | 'not-alive' | 'gone'` (a throw counts as a failed attempt).
  - `enqueue(input: { targetId: string; sourceId?: string; kind: OutboxKind; body: string; dedupKey: string }): { id: number; state: OutboxState; duplicate: boolean }`
    It writes the row first, then tries one delivery in the same call.
  - `flush(targetId: string): number` (tries each pending row for the target, oldest first)
  - `drop(targetId: string, reason: string): number` ; `list(filter: { terminalId?: string; state?: OutboxState; limit?: number }): OutboxRow[]`
  - `onDelivered(fn: (row: OutboxRow) => void): void`
- **No timer.** A retry runs on an event:
  1. the target's `process.started` harness event (`StatusService.onHarnessCommitted`);
  2. the target's settled edge (`StatusService.addThreadSettledListener`);
  3. once at boot, after the kickstart.
  A row is dropped after 5 attempts, or when the target is archived or removed (`gone`).
- The outbox does not revive a dead target. A notice for a coordinator that is not running stays pending and is delivered when the coordinator runs again.
  Today that notice is lost (`service.ts:1442-1455`).
- Callers:
  - `deliverToStarter` enqueues with `dedupKey = notice:<workerId>:<kind>:<lifecycle generation>:<sequence>` (use the values that `StatusService.accept` already records).
  - `WatchDispatcher.fire` enqueues with `dedupKey = watch:<watchId>:<id of the lifecycle event that settled the target>`.
    `watchesDb.markFired` moves into the `onDelivered` handler. A one-shot watch with a pending row is not matched again
    (new column `pending_delivery_id` on `thread_watches`, or a join; pick the smaller change).
  - `kickstartInterruptedAgents` is not changed in this wave (W2-A owns that region). The boot flush runs after it.
- **Boot reconcile** (`boot-reconcile.ts`, called once in the boot `finally` block):
  `reconcileAtBoot(deps): { lostWakes: string[]; restoredQuestions: string[] }`
  - Lost wakes: a thread with status `scheduled` whose process is dead. Write a `wake.lost` lifecycle event, set the thread to idle
    with the activity text "A scheduled wake was lost when Dispatch restarted", and enqueue a `lost-wake` notice to its starter if it has one.
    It does not restart the thread.
  - Pending questions: table `pending_questions(terminal_id TEXT PRIMARY KEY, request_id TEXT, payload TEXT, created_at TEXT)`.
    A row is written on the manager's `permission` event with a question payload and removed on the resolve event.
    At boot, a row whose process is dead stays; the thread keeps status `needs_input`; `getPendingPermission` returns the saved payload,
    so the question shows as the same inline card as before. An answer revives the thread and is sent as a normal user message
    that quotes the question. No strip and no popup (constraint 3).
- The Chat table `endless_pending_reports` is not changed.

**Interfaces produced**
- `DeliveryOutbox` (`enqueue`, `flush`, `drop`, `list`, `onDelivered`), `OutboxRow`, `OutboxKind`, `OutboxState`.
- `pendingQuestionsDb.get/put/remove`. `reconcileAtBoot`.
- W2-G reads `outbox.list({ terminalId })`. W3-B moves the notice code into `CoordinatorNotifier` with the outbox as a required dependency.

**Tests first**
- `delivery/outbox.test.ts`
  - "enqueue delivers at once when the target is alive and marks the row delivered"
  - "enqueue keeps the row pending when the target is not alive" ; "flush delivers the pending rows in order"
  - "the same dedup key enqueues once and reports duplicate" ; "a row is dropped after five failed attempts with the last error saved"
  - "rows survive a new DeliveryOutbox on the same database" (restart) ; "drop marks every pending row of an archived target"
  - "no timer is created" (assert with fake timers that the timer count is zero)
- `sessions/watch-dispatcher.test.ts` (add; existing tests stay green)
  - "a one-shot watch stays live when delivery fails and fires when the watcher runs again"
  - "a watch is marked fired only after the delivery" ; "the same settle event does not enqueue twice"
- `sessions/coordinator-notice` tests (add to the existing file that covers `noteAgentCompletion`)
  - "a Finished notice for a coordinator that is not running is delivered after its next process start"
  - "a notice for an archived coordinator is dropped with a reason"
- `sessions/boot-reconcile.test.ts`
  - "a scheduled thread with a dead process becomes idle with the lost-wake text and one lifecycle event"
  - "a saved question is returned by getPendingPermission after a restart" ; "the row is removed when the question is resolved"
  - "an answer to a restored question revives the thread and sends one message"
- `packages/web/src/lib/noAskStrip.test.ts` stays green.

**Acceptance:** all tests pass; in the isolated instance, stop a fake coordinator, finish a fake worker, start the coordinator: the notice arrives once.

**Effort:** M to L.

---

### W2-D: Shared structured-transport core

**Covers:** daemon roadmap #3 and #4 (the map); performance table #8; reliability table #10 (existing fixtures).

**Owns**
- new `packages/core/src/structured/shared/` (`jsonrpc-client.ts`, `event-ring.ts`, `settle-turn.ts`, `events.ts`, tests)
- `packages/core/src/structured/manager.ts`, `codex-manager.ts`, `grok-manager.ts` (renamed to `acp-manager.ts`; `grok-manager.ts` stays as a re-export)
- The translators and fixtures in `packages/core/src/structured/` (read; change only for the contract tests)
- `packages/core/src/server.ts`: the import lines and constructor calls of the managers only

**Design**
- `class JsonRpcStdioClient extends EventEmitter` replaces `CodexConnection` (`codex-manager.ts:52`) and `GrokConnection` (`grok-manager.ts:60`).
  `request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>` ; `notify(method: string, params?: unknown): void` ;
  `respond(id: number | string, result: unknown): void` ; `respondError(id, code: number, message: string): void` ; `close(): void`.
  Events: `notification`, `request`, `exit`, `stderr`. A line that is not JSON is counted and skipped, never thrown.
- `class EventRing`
  `constructor(opts?: { maxEvents?: number; maxBytes?: number })` (defaults 5,000 and 8 MB) ;
  `push(event: unknown): void` ; `seed(events: unknown[]): void` ; `snapshot(): unknown[]` ; `length: number` ; `bytes: number` ;
  `lastPushAt: number | undefined` ; `compact(isDeltaOf: (e: unknown) => string | null, messageId: string): number`.
  - It replaces the 12 trim sites (`manager.ts:378,413,490,648,782,804`; `codex-manager.ts:313,671,677`; `grok-manager.ts:231,437,443`).
  - Compaction: when a full assistant message arrives, the ring drops the stream deltas of that message. A replay then holds whole messages.
  - `lastPushAt` backs `IStructuredManager.lastFrameAt` (from W1-D).
- `settleTurn(session: SettleSession, action: SettleAction, deps: SettleDeps): void` joins `codex-manager.ts:569` and `grok-manager.ts:405`.
  The Claude `result` handler (`manager.ts:~512`) calls it where the logic is the same; note the differences in a comment.
- `AcpStructuredSessionManager` is the new class name. `GrokStructuredSessionManager` stays as an alias export (the pattern at `manager.ts:881`).
- Typed event map: `interface StructuredManagerEvents` lists each event name with its argument tuple (`event`, `exit`, `permission`,
  `permission-resolved`, and the others that the managers emit today). `IStructuredManager` declares typed `on`, `off`, `emit` for the map.
  The raw listeners in `sessions/service.ts:381-455` are not moved in this wave (W2-A owns the file); they get compile-time types only.
- Behaviour does not change, except for ring compaction.

**Interfaces produced**
- `JsonRpcStdioClient`, `EventRing`, `settleTurn`, `StructuredManagerEvents`, `AcpStructuredSessionManager`.
- `EventRing.onCommit?: (event: unknown) => void` hook point (not used yet; W3-D writes the journal from it).

**Tests first**
- `structured/shared/event-ring.test.ts`: "drops the oldest events over the count limit" ; "drops the oldest events over the byte limit" ;
  "compact removes the deltas of a finished message and keeps the message" ; "snapshot order equals push order" ; "lastPushAt moves on push".
- `structured/shared/jsonrpc-client.test.ts`: "request resolves with the matching id" ; "request rejects after the timeout" ;
  "a server request is emitted and respond writes the answer" ; "a non-JSON line is skipped" ; "exit rejects every pending request".
- `structured/shared/settle-turn.test.ts`: "idle settles once per turn" ; "needs-help marks the declaration" ; "a second settle for the same turn is ignored".
- `structured/shared/contract.test.ts`: replays `codex-frames.fixture.ts`, `grok-frames.fixture.ts` and `opencode-frames.fixture.ts` through
  the real manager with a fake process. For each: "the turn opens once and settles once" ; "the ring holds the final message" ;
  "the emitted HarnessEvents equal the recorded list" (record the list from the code **before** the refactor and commit it as the expectation).
- All existing `structured/*.test.ts` and `ws/structured.test.ts` files stay green without an edit to their assertions.

**Acceptance:** all tests pass; about 300 repeated lines are gone (write the line counts before and after in the hand-off); the isolated daemon starts.

**Effort:** M to L.

---

### W2-E: Bundle split and streamed markdown

**Covers:** top 15 #7 (markdown part) and #8; performance table #4, #5.

**Owns**
- `packages/web/vite.config.ts` (`build.rollupOptions`), new `packages/web/scripts/check-bundle.mjs`
- `packages/web/src/App.tsx`: the import block and the view switch (lazy imports and `Suspense`) only
- `packages/web/src/components/Markdown.tsx`, `packages/web/src/lib/markdown.ts`, new `packages/web/src/lib/highlight.ts`, new `packages/web/src/hooks/useThrottledValue.ts`
- `packages/web/src/components/tabs/chat/timeline/` the assistant-text leaf only (to pass a `streaming` flag)
- The files that import a now-lazy module statically (change the import to the lazy wrapper)

**Design**
- Lazy chunks: the phone shell and the desktop shell (each loads only on its own width), Settings, the Control Plane view,
  the setup wizard, the update game (`components/update/blaster`). Each sits in `Suspense` inside the view's error boundary (W1-G).
- `manualChunks`: `react` vendor, the terminal emulator, markdown plus sanitizer, the icon set. Keep the chunk names stable.
- `loadLanguage(name: string): Promise<boolean>` imports one `highlight.js` language on demand. A code block renders plain first
  and is highlighted when the language arrives. Keep `javascript`, `typescript`, `json`, `bash`, `diff` in the markdown chunk.
- `check-bundle.mjs` reads the build manifest and fails when the entry chunk is over 260 KB gzip. It runs in the worktree after a build.
- `useThrottledValue<T>(value: T, ms: number, active: boolean): T`. While a message streams, the text passes to the parser at most every 100 ms.
  The last value always renders when the stream ends.
- Block cache: split the text into top-level blocks (blank-line boundaries outside a code fence). The HTML of each closed block is cached by its text.
  Only the last, open block is parsed again.
- One sanitize pass per block. Chips and links keep their behaviour (`Markdown.tsx:38-51`, `:175`, `:221`).
- The final HTML of a finished message is identical to today's output.

**Interfaces produced**
- `loadLanguage`, `useThrottledValue`, `Markdown` prop `streaming?: boolean`.

**Tests first**
- `hooks/useThrottledValue.test.ts`: "200 changes in one second give at most 11 outputs" ; "the last value is delivered when active turns false" ; "inactive passes every value".
- `components/Markdown.test.tsx` (add; all existing tests stay green)
  - "the streamed result of a text equals the one-shot result" (run it over every fixture text in the file)
  - "a closed block is not parsed again when text is added after it" (spy on the parser)
  - "a code fence that is still open is not split" ; "sanitize runs once per block per render"
- `lib/highlight.test.ts`: "an unknown language resolves false and the block stays plain" ; "a loaded language highlights on the next render".
- `App.test.tsx` (add): "the phone width does not import the desktop shell module" (mock the two modules and assert which factory ran).
- `scripts/check-bundle.test.mjs`: "fails over the budget, passes under it" (with a fake manifest).

**Acceptance:** all web tests pass; a worktree build passes `check-bundle.mjs`; write the entry size before and after in the hand-off.

**Effort:** M.

---

### W2-F: Navigation store, desktop URL routes and the attention queue

**Covers:** top 15 #9 (attention queue); web table #3 and #4 (mobile navigation hook); product table #2.

**Owns**
- new `packages/web/src/stores/navigation.ts`, new `packages/web/src/lib/routes.ts`, new `packages/web/src/lib/attention.ts`, and their tests
- `packages/web/src/stores/ui.ts` (the four pending fields `:46-84`), `packages/web/src/stores/mobileNav.ts`
- `packages/web/src/App.tsx`: the effects that read the pending fields and the URL (`:90-160` region) only
- `packages/web/src/components/mobile/MobileApp.tsx` (navigation code `:140-275`), new `components/mobile/useMobileNavigation.ts`
- `packages/web/src/components/sidebar/ProjectSidebar.tsx` (filter bar and the new list section), `components/mobile/AllThreadsView.tsx` (filter)
- `packages/web/src/components/CommandPalette.tsx`: the open actions and one new row
- Every caller of `requestOpenTab`, `requestOpenThread`, `requestOpenProject`, `requestSettings`

**Design**
- `type Route =`
  `| { view: 'workspace'; projectId?: string; threadId?: string; agentId?: string }`
  `| { view: 'settings'; section?: string; subPage?: string }`
  `| { view: 'chat' } | { view: 'analytics' } | { view: \`plugin:${string}\` }`
- `parseRoute(pathname: string, basePath: string): Route` ; `routeHref(route: Route, basePath: string): string`.
  Paths: `/`, `/p/:project`, `/p/:project/t/:thread`, `/p/:project/a/:agent`, `/settings`, `/settings/:section`, `/chat`, `/analytics`, `/x/:pluginView`.
  The phone paths of today stay valid, so an installed PWA link still opens.
- `useNavigation`: `{ route: Route; navigate(route: Route, opts?: { replace?: boolean }): void; back(): void }`.
  One `popstate` listener. `navigate` pushes history and then sets the active project and tab through the existing stores.
- The four pending fields go away. `requestOpenThread` and the other three stay as thin wrappers that call `navigate`
  (the plugin SDK exposes `useUI`; W3-F removes that exposure).
- `useMobileNavigation()` holds the push and restore logic that is in `MobileApp.tsx` today, on top of the same store.
- The daemon already serves the page for any path outside `/api` (`server.ts:1075`). No server change.
- **Attention queue.**
  `attentionList(input: { byProject: Record<string, Terminal[]>; status: ThreadStatusMap; stalls: Record<string, number> }): AttentionItem[]`
  with `AttentionItem = { terminalId: string; projectId: string; label: string; reason: 'needs_input' | 'error' | 'stalled'; since: number }`.
  Order: needs input, error, stalled; oldest first inside a group.
  - Sidebar and phone list: a status filter (All, Needs you, Working) in the existing `FilterBar`.
  - One collapsible list section "Needs you (N)" above the projects, across all projects. A row opens the thread. It has no Answer button.
  - Shortcut `Alt+N` goes to the next item (check for a clash first). The palette gets the row "Next thread that needs you".
  - This is a list and a filter in the navigation. It is not a strip inside a thread (constraint 3).

**Interfaces produced**
- `Route`, `parseRoute`, `routeHref`, `useNavigation`, `attentionList`, `useAttention(): AttentionItem[]`.
- W3-F gives plugins `sdk.navigate(route)` on top of this.

**Tests first**
- `lib/routes.test.ts`: "parse and href are inverse for every route kind" ; "a base path prefix is removed and added" ; "an unknown path parses as the workspace root" ; "the phone agent path parses".
- `stores/navigation.test.ts`: "navigate pushes one history entry and sets the active tab" ; "popstate restores the earlier thread" ;
  "replace does not add an entry" ; "a route to a thread that does not exist falls back to its project".
- `App.test.tsx` (add): "loading /p/A/t/T on desktop opens thread T" ; "the pending fields no longer exist on the UI store".
- `components/mobile/MobileApp` tests: all existing navigation tests stay green.
- `lib/attention.test.ts`: "orders needs input before error before stalled" ; "oldest first in a group" ; "an archived thread is not listed".
- `sidebar/ProjectSidebar.test.tsx` (add): "the Needs you filter shows only threads that need input or have an error" ;
  "the Needs you section has no button with the name Answer" ; `lib/noAskStrip.test.ts` stays green.

**Acceptance:** all web tests pass; in a worktree build, the browser Back button returns to the earlier thread on desktop, and a copied thread URL opens that thread.

**Effort:** M to L.

---

### W2-G: "Why is this thread in this state" panel and `dispatch doctor`

**Covers:** the Phase 2 panel; reliability table #9 (panel and doctor).

**Owns**
- new `packages/core/src/status/explain.ts` and its test
- `packages/core/src/routes/terminals.ts` lines `137-141` (the diagnostics route)
- `packages/core/src/status/service.ts`: `diagnostics()` only (`:40-46`)
- new `packages/web/src/components/inspector/WhyPanel.tsx` and its test; one menu item in the thread menu component; `packages/web/src/api/client.ts` (one function), `api/types.ts` (one type)
- `bin/dispatch` (`doctor` subcommand only)

**Design**
- `explainThread(input: ExplainInput): Explanation`, a pure function.
  `ExplainInput = { status: ThreadStatus; turnOpen: boolean; processAlive: boolean; transport: 'structured' | 'pty'; lastEvents: LifecycleEventRow[]; stall: StallState | null; park: ParkState | null; pendingQuestion: boolean; deliveries: OutboxRow[]; now: number }`
  `Explanation = { headline: string; since: string | null; reasons: string[]; nextSteps: { label: string; action: 'reset-status' | 'restart' | 'open-usage' | 'none' }[] }`.
  It is a table of rules, in order. Examples: working and stalled; working and the process is dead; parked for a usage limit until a time;
  needs input with a restored question; idle with an undelivered notice.
- `GET /api/terminals/:id/diagnostics` adds the fields `process`, `stall`, `park`, `pendingQuestion`, `deliveries` (last 20, to and from the thread) and `explanation`.
  Each new source is an optional injection. A source that is absent gives `null` or `[]`, so the route works before W2-C merges.
- `WhyPanel({ terminalId })`: the headline, the reasons, the last 20 lifecycle events in a compact table, the deliveries with their state,
  and buttons for the next steps (they call routes that exist today). It opens from the thread menu item "Why is this thread in this state?".
  Phosphor icons only.
- `./bin/dispatch doctor <thread id>` calls the route through `dispatch api` and prints the headline, the reasons and the event table as plain text.
  `--json` prints the raw answer.

**Interfaces consumed**
- `DeliveryOutbox.list` (W2-C), `StallWatchdog.get` (W1-D), the limit park state (existing `limits/` service), `pendingQuestionsDb.get` (W2-C).

**Tests first**
- `status/explain.test.ts`: one test per rule, for example "a working thread with a dead process says that the process ended and offers Reset status" ;
  "a parked thread names the reset time" ; "a stalled thread says that it only flags" ; "an idle thread with a pending notice names the target" ;
  "an input with no special condition gives a plain headline and no next step".
- `routes/terminals.test.ts` (add): "diagnostics answers with empty deliveries when no outbox is wired" ; "it includes the explanation".
- `inspector/WhyPanel.test.tsx`: "shows the headline and the reasons" ; "a next-step button calls the matching API function" ; "shows a load error inside the panel".

**Acceptance:** all tests pass; `./bin/dispatch doctor <id>` against the isolated instance prints an explanation.

**Effort:** M.

---

### 4.8 Wave 2 integration

**Order**
1. W2-D (structured core). It is isolated from `sessions/service.ts`.
2. W2-A (config store). It is the widest change in `sessions/service.ts`; merge it early.
3. W2-B (rebases its lent region on A).
4. W2-C (rebases its lent region on A; its watch code builds on the W1-D change).
5. W2-G (then wire the outbox, the watchdog and the question table into the diagnostics route).
6. W2-E.
7. W2-F (rebases `App.tsx` and the palette on E and on Wave 1).

**Integrator tasks after the merges**
- Move the config writes inside the two lent regions (if any were added by B or C) to `ThreadConfigStore.patch`. Run the guard test.
- Wire `DeliveryOutbox.list`, `StallWatchdog.get` and `pendingQuestionsDb.get` into the diagnostics route.
- Confirm that the client renders a compacted replay correctly (W2-D) with the throttled markdown (W2-E).
- Run the integration test plan of section 1A.4 (full suites, type-check, linter, `check-bundle.mjs`, smoke start, end-to-end pass).

**Known conflict points**

| File | Streams | Rule |
|---|---|---|
| `packages/core/src/sessions/service.ts` | A (all but two regions), B (`1046-1206`), C (`1397-1464`) | A must not edit the two lent regions; if it finds a config write there, it lists it for the integrator. B and C rebase on A. |
| `packages/core/src/status/service.ts` | A (`:283`, `:356`, `:448`), G (`diagnostics()` `:40-46`) | Regions do not overlap. |
| `packages/core/src/routes/terminals.ts` | B (`116-135`), G (`137-141`) | Adjacent regions; merge B first. |
| `packages/core/src/server.ts` | C (watch wiring, three lines), D (manager imports and constructors) | Regions do not overlap. |
| `packages/core/src/db/schema.ts` | C (two appended migrations) | Only C adds migrations in this wave. |
| `packages/core/src/structured/*` | D only | W1-D's `lastFrameAt` moves into `EventRing.lastPushAt`; keep the W1-D tests green. |
| `packages/web/src/App.tsx` | E (imports, view switch), F (navigation effects) | Merge E first. |
| `packages/web/src/components/CommandPalette.tsx` | F | E does not touch it. |
| `packages/web/src/api/client.ts`, `api/types.ts` | G (one function, one type) | Append only. |
| `bin/dispatch` | G (`doctor`) | Append only. |

---

## 5. Wave 3: restructure

Base: the integrated Wave 2. Seven workstreams. Two of them have a gate.

- **Gate 1:** W3-B starts when W3-A is merged into the wave branch.
- **Gate 2:** W3-D starts its client work when the first commit of W3-C (the move-only split of `useStructuredChat`) is merged into the wave branch.
  Its server work can start at once.

### W3-A: `buildDaemon()` and the split of `startServer`

**Covers:** daemon roadmap #5.

**Owns**
- `packages/core/src/server.ts`, `packages/core/src/server-routes.ts`
- new `packages/core/src/daemon/` (`build.ts`, `wire-auth.ts`, `wire-limits.ts`, `wire-pty.ts`, `wire-plugins.ts`, `wire-harnesses.ts`, `timers.ts`, tests)
- `packages/core/src/ws/events.ts` (the broadcaster type), `packages/core/src/ws/server-events.ts`

**Design**
- `buildDaemon(opts: BuildDaemonOptions): Daemon`
  `BuildDaemonOptions = { db: Database.Database; dataDir: string; env?: NodeJS.ProcessEnv; clock?: () => number; auth?: 'open' | 'gate'; managers?: Partial<Record<string, IStructuredManager>>; pty?: PtyLike; network?: boolean; timers?: boolean; webDist?: string | null }`
  `Daemon = { app: express.Express; services: DaemonServices; attach(server: http.Server): void; startTimers(): () => void; bootRecover(): Promise<void>; stop(): void }`.
- `createApp(options)` (`server.ts:403`) becomes a thin call: `buildDaemon({ ...options, auth: 'open', network: false, timers: false }).app`.
  The 53 test files that use `createApp` need no edit and now get the same wiring as production, minus the gate, the network and the timers.
- `startServer` (`server.ts:515`) becomes: build, attach, listen (with `DISPATCH_BIND`), start timers, boot recover.
- Each `wire*` function takes typed inputs and returns typed services. A required input that is absent is a compile error or a throw at build time.
  A missing wire is never a silent no-op.
- `timers.ts` holds every `setInterval` of today in one list (heartbeat, marketplace check, the 30 s tick, PTY timing, update check, telemetry, auto-archive, interim recap).
  This wave adds no timer.
- `EventsBroadcaster.broadcast(e: ServerEvent)` becomes typed with the union from W1-G. Fix the call sites that do not match; add the missing event shapes to the union.

**Interfaces produced**
- `buildDaemon`, `Daemon`, `DaemonServices` (named fields for every service). W3-B takes its constructor inputs from here.

**Tests first**
- `daemon/build.test.ts`: "buildDaemon with auth open serves /api/sessions" ; "with auth gate a remote Host gets the sign-in page" ;
  "timers false creates no interval" (fake timers) ; "stop clears every interval" ; "a build with no db throws a clear error".
- `daemon/parity.test.ts`: "the route table (method and path) of createApp equals the route table of the production build" ;
  "every service that production wires into SessionService is also wired in the test build" (compare the list of wired setters or constructor fields).
- `tests/server/startup.test.ts` (extend what exists): "startServer on a random port answers /api/sessions and stops cleanly".
- All 53 `createApp` test files stay green **without an edit**. If one fails because it relied on a missing wire, record it; that test was hiding a gap.

**Acceptance:** all core tests pass; `startServer` is under 80 lines; no `wire*` function is over 200 lines; the isolated daemon starts.

**Effort:** L.

---

### W3-B: Split `SessionService` (starts after Gate 1)

**Covers:** daemon roadmap #6 and the second half of #4.

**Owns**
- `packages/core/src/sessions/service.ts`
- new `packages/core/src/sessions/coordinator-notifier.ts`, `thread-settings-service.ts`, `thread-spawner.ts`, `boot-recovery.ts`, and tests
- `packages/core/src/daemon/wire-harnesses.ts` and the `SessionService` construction in `daemon/build.ts` (after W3-A)

**Design**
- Five services. `SessionService` stays as a facade with the same public methods, so routes, tools and tests do not change.

| Service | Takes from `service.ts` (line numbers at the plan commit) |
|---|---|
| `ConversationReader` | Done in W2-B. Remove the delegate's extra code; keep the facade method. |
| `CoordinatorNotifier` | `1397-1920`: starter notices, interim timer, agent questions, lifecycle notes, completion, needs-help, turn outcome |
| `ThreadSettings` | `2081-2650`: autonomy, transport switch, account switch, model and effort, refused picks |
| `ThreadSpawner` | `2825-3440` and `3546-3650`: spawn (PTY and structured), MCP config files, keys at spawn, `ensureStructuredAlive` |
| `BootRecovery` | `3438-3545`: kickstart, shutdown that keeps interrupted turns; plus `reconcileRunsAtBoot` (W1-D) and `reconcileAtBoot` (W2-C) behind one `run()` |

- Each service takes its inputs by constructor: `ThreadConfigStore`, `DeliveryOutbox`, the manager registry, the PTY manager, `StatusService`.
  The 30 optional setters go away where the input is known at build time. A setter stays only for a real cycle; list each one that stays, with the reason.
- The raw manager listeners (`service.ts:381-455`: lost conversations, message sources, session ids) move to typed `HarnessEvent` consumers, or to typed listeners on `StructuredManagerEvents` where no harness event fits.
- Harness capability table: `harnessCapabilities(type): { restHistory: boolean; bootKickstart: boolean; structured: boolean; … }` replaces the name comparisons where the meaning is a capability. Do this only for the comparisons that move in this split.
- Daemon board state (`setBoardState` at `service.ts:1878`, the override clear at `status/service.ts:444-449`): remove it only if a search shows no reader in web, plugins or tools after W1-G. Otherwise leave it and list it.
- Step 1 is move-only commits, one per service. The suite passes after each. Step 2 changes the constructors. Step 3 moves the listeners.

**Interfaces produced**
- The four new classes with typed constructors. `SessionService` public API is unchanged.

**Tests first**
- One unit test file per new service, built **without** `SessionService`:
  - `coordinator-notifier.test.ts`: "a completed agent enqueues one Finished notice for its starter" ; "a queued dependent starts when its dependency is done"
  - `thread-settings-service.test.ts`: "a model switch on a busy thread is refused with the same error as before" ; "an effort change patches only the effort key"
  - `thread-spawner.test.ts`: "a structured spawn writes the MCP config and mints one key" ; "a spawn with no room in the project throws the cap error"
  - `boot-recovery.test.ts`: "run() kickstarts, closes orphan runs, flags lost wakes and flushes the outbox, in that order"
- `tests/sessions/facade-parity.test.ts`: "every public method name of SessionService at the wave base still exists" (a recorded list).
- `tests/sessions/no-optional-wire.test.ts`: "SessionService has no set* method outside the recorded allow-list".
- Every existing test stays green after each move-only commit.

**Acceptance:** all core tests pass; `service.ts` is under 1,200 lines; each new file is under 900 lines; the isolated daemon starts and a full thread cycle works (start, message, model switch, stop, restart).

**Effort:** L.

---

### W3-C: One status authority

**Covers:** top 15 #6; reliability table #4; cause A; web table #4 (the `useStructuredChat` split).

**Owns**
- `packages/core/src/status/service.ts`, `status/events.ts`, `status/aggregate.ts`
- `packages/core/src/ws/structured.ts`: the first-frames block (`:134-152`) and the live status frame
- Every caller of `terminalsDb.updateStatus` outside `status/` (route each through `StatusService`)
- The `turnOpen` field of the managers (read access only; the managers report the edge, they are not asked for it)
- `packages/web/src/components/tabs/chat/useStructuredChat.ts`, new `chat/useChatSocket.ts`, `chat/useChatHistory.ts`, `chat/useChatQuestions.ts`
- `packages/web/src/stores/threadStatus.ts`

**Design**
- `thread_lifecycle` is the one record of status. It holds `status`, `turn_open`, `generation`, `sequence`, `observed_at`.
  `terminals.status` is a mirror that only `StatusService.apply` writes.
- `StatusService.snapshot(terminalId: string): StatusSnapshot` with
  `StatusSnapshot = { status: ThreadStatus; turnOpen: boolean; generation: number; sequence: number; at: string; activity: string | null }`.
- On the structured socket, the first frame is `{ type: 'system', subtype: 'status', ...StatusSnapshot }`. It comes before the replay.
  After each committed transition, the same frame is sent live.
- The `terminal:status` event on the events socket gets `turnOpen`, `generation`, `sequence`.
- The synthetic settle frame (`ws/structured.ts:144-146`) stays for one release, for a cached old client. Mark it for removal in the code and in the release note.
- Client: commit 1 is a move-only split of `useStructuredChat.ts` (1,125 lines) into socket, history and questions modules. **Merge this commit to the wave branch at once (Gate 2).**
- Client: `busy` is no longer folded from frames. `busy = snapshot.turnOpen || sending`.
  `sending` is a local flag from the POST until the first status frame with a higher sequence, with a 10 s fallback that fetches the snapshot by REST.
  The 20 `setBusy` sites go away. A client that receives no status frame (an old daemon) keeps the old fold behind one branch.
- A status frame with a lower `(generation, sequence)` than the last one seen is ignored.

**Interfaces produced**
- `StatusSnapshot`, `StatusService.snapshot`, the `system/status` frame, `GET /api/terminals/:id/status` (the snapshot, for the fallback).
- `useChatSocket`, `useChatHistory`, `useChatQuestions` (W3-D edits `useChatHistory`).

**Tests first**
- `status/service.test.ts` (add): "snapshot equals the last committed transition" ; "no code path writes terminals.status outside apply" (a guard test that searches for `updateStatus(`).
- `ws/structured.test.ts` (add; existing tests stay green): "the status frame is the first frame" ; "a replay that ends mid-turn on a settled thread has turnOpen false in the header" ;
  "a live transition sends one status frame with the next sequence".
- `chat/useStructuredChat.test.ts` (existing 1,536 lines stay green through the split; then add)
  - "busy follows the header and not the replayed frames" ; "a replay with an open tool call and a header with turnOpen false shows not busy"
  - "sending shows busy until the first status frame" ; "an older status frame is ignored" ; "with no status frame the old fold still works"
- `stores/threadStatus.test.ts` (add): "terminal:status with a lower sequence does not overwrite a newer one".

**Acceptance:** all tests pass; in the isolated instance, reload the page during a fake turn and after it: the spinner is right both times with no Reset status.

**Effort:** L.

---

### W3-D: Daemon message journal (client work starts after Gate 2)

**Covers:** reliability table #8; causes C and F (history part).

**Owns**
- new `packages/core/src/journal/` (`journal.ts`, `db.ts`, tests); `packages/core/src/db/schema.ts` (one appended migration `w3d-thread-journal`)
- `packages/core/src/structured/shared/event-ring.ts` (the `onCommit` hook use) and the place in each manager where a finished item is known
- `packages/core/src/ws/structured.ts`: the replay body (after the first-frames block)
- new route file `packages/core/src/routes/journal.ts`; `packages/core/src/http/idempotency.ts` (durable keys)
- `packages/web/src/components/tabs/chat/useChatHistory.ts`

**Design**
- Table `thread_journal`: `terminal_id TEXT`, `seq INTEGER`, `kind TEXT` (`user | assistant | tool | result | notice`), `native_id TEXT`,
  `payload TEXT` (JSON, at most 256 KB; a larger payload is cut and flagged), `idem_key TEXT`, `at TEXT`. Primary key `(terminal_id, seq)`. Unique `(terminal_id, idem_key)` where the key is not null.
- `class MessageJournal`
  `append(terminalId: string, item: JournalInput): number` (returns the sequence; the same `native_id` for a thread updates the row and keeps the sequence) ;
  `page(terminalId: string, opts: { beforeSeq?: number; afterSeq?: number; limit?: number }): { items: JournalItem[]; firstSeq: number; lastSeq: number; hasMore: boolean }` ;
  `lastSeq(terminalId: string): number` ; `removeThread(terminalId: string): void`.
- The journal is written on the event, when an item is finished: a user message accepted, an assistant message complete, a tool call with its result, a result footer, a notice.
  Stream deltas are not written. No scan and no timer.
- Each finished item that goes to a client carries `seq`. The client removes duplicates by `(terminalId, seq)`. The content fingerprint stays only for an item with no `seq` (history from before the journal).
- `GET /api/terminals/:id/journal?before=&after=&limit=` with the same key rules as the conversation route.
- Grok and OpenCode threads get history that survives a restart: `historyRestPageable` answers true for them through the journal.
  Claude and Codex keep the transcript route for older history; the journal page reports `firstSeq` so the client knows where to change source.
- The `Idempotency-Key` of W1-D is saved in `idem_key`. A repeated key is refused after a restart too.
- Rows are removed when a thread is deleted, not when it is archived.

**Interfaces consumed:** `EventRing.onCommit` (W2-D), `useChatHistory` (W3-C), `StatusSnapshot.sequence` is separate from the journal sequence (name the two differently in the code: `statusSeq`, `seq`).

**Tests first**
- `journal/journal.test.ts`: "append gives 1, 2, 3 per thread" ; "two threads have independent sequences" ; "the same native id updates in place" ;
  "page before and after return the right windows" ; "a payload over the limit is cut and flagged" ; "a repeated idempotency key is refused".
- Per manager (three tests): "a finished assistant message is journaled once; its deltas are not".
- `ws/structured.test.ts` (add): "replayed finished items carry seq" ; "a reconnect with afterSeq sends only newer items".
- `routes/journal.test.ts`: "a thread key reads its own journal" ; "a Grok thread returns history after a new daemon instance on the same database".
- `chat/useChatHistory.test.ts`: "two items with the same seq render once" ; "items with no seq still use the fingerprint" ; "older pages change to the transcript route below firstSeq".

**Acceptance:** all tests pass; in the isolated instance a fake ACP thread shows its history after a daemon restart.

**Effort:** L.

---

### W3-E: UI primitives and tokens

**Covers:** web table #5.

**Owns**
- new `packages/web/src/components/ui/` (`Button.tsx`, `IconButton.tsx`, `Menu.tsx`, `Popover.tsx`, `ui.css`, `index.ts`, tests)
- `packages/web/src/components/common/Modal.tsx`, `ConfirmModal.tsx`
- `packages/web/src/theme.css` (new tokens only; do not change a colour token)
- Adoption (bounded): `packages/web/src/components/settings/**` and the modals under `components/common/` and `components/sidebar/NewThreadModal.tsx`
- new `packages/web/src/test/raw-button-ratchet.test.ts`; update `docs/design/settings-layout.md`

**Design**
- Tokens: type scale `--text-xs … --text-xl` (6 steps for the 22 sizes of today), space scale `--space-1 … --space-8`,
  layer scale `--z-base, --z-sticky, --z-dropdown, --z-overlay, --z-modal, --z-toast` (for the 30 z-index values).
- `Button({ variant: 'primary' | 'secondary' | 'ghost' | 'danger'; size: 'sm' | 'md'; icon?: ReactNode; loading?: boolean } & ButtonHTMLAttributes)`.
- `IconButton({ label: string; icon: ReactNode; size?: 'sm' | 'md' } & …)`. `label` is required (it becomes `aria-label` and the title). Padding is 0 with a fixed size (the squish bug).
- `Menu` and `Popover`: anchored, close on Escape and outside press, arrow-key movement in `Menu`, stay inside the window, use the layer tokens.
- `Modal`: focus trap, focus returns to the opener on close, Escape closes, `aria-modal`, `role="dialog"`, a labelled title.
- One global `:focus-visible` rule in `ui.css`.
- CSS classes, not inline style objects, in the primitives. Phosphor icons only.
- The ratchet test counts raw `<button` in the adopted folders and fails when the count goes up. It records the count at merge.
- The rest of the app is not converted in this program.

**Interfaces produced:** the five primitives and the tokens. W3-F and W3-G use them for new UI.

**Tests first**
- `ui/Button.test.tsx`: "loading disables the button and keeps its width" ; "renders the icon before the label".
- `ui/IconButton.test.tsx`: "has the label as accessible name" ; "has zero padding and the fixed size class".
- `ui/Menu.test.tsx`: "arrow keys move the active item" ; "Escape closes and returns focus" ; "an outside press closes".
- `ui/Popover.test.tsx`: "stays inside the viewport near the right edge".
- `common/Modal.test.tsx` (add): "Tab from the last control goes to the first" ; "focus returns to the opener" ; "has role dialog and aria-modal".
- `test/raw-button-ratchet.test.ts`: "the count in the adopted folders is at most the recorded count".

**Acceptance:** all web tests pass; the Settings pages look the same in the light and dark default themes (compare screenshots from a worktree build; put them in the hand-off).

**Effort:** M to L.

---

### W3-F: Narrow plugin SDK

**Covers:** web table #6.

**Owns**
- `packages/web/src/plugins/` (`sdk.tsx`, `host.ts`, `registry.ts`, tests), new `packages/web/src/plugins/facade.ts`
- `packages/plugins/coach/web.js`, `packages/plugins/previews/web.js`, their manifests
- The plugin developer document under `docs/` (find the SDK reference)

**Design**
- `createPluginSdk(pluginId: string): DispatchSdkV2`. The id is bound; no function takes a plugin id from the caller.
- `DispatchSdkV2`
  - `version: 2`
  - `docs: { get<T>(key, fallback: T): Promise<T>; set(key, value): Promise<void>; delete(key): Promise<void>; keys(): Promise<string[]>; entries<T>(): Promise<{ key: string; value: T }[]> }`
  - `settings: { get<T>(): Promise<T>; set(value: unknown): Promise<void> }`
  - `threads: { list(): ThreadInfo[]; get(id): ThreadInfo | null; status(id): ThreadStatusInfo | null; onChange(fn): () => void }`
  - `projects: { list(): ProjectInfo[]; active(): ProjectInfo | null; onChange(fn): () => void }`
  - `navigate(route: Route): void` (W2-F) ; `ui: { hint(text: string): void }`
  - `worker: { fetch(path: string, init?: RequestInit): Promise<Response> }` ; `assist(req: PluginAssistRequest): Promise<…>` ; `url(path: string): string`
  - `events: { on(type: string, fn: (e: ServerEvent) => void): () => void }`
  - `register(contribution)` as today.
- `ThreadInfo`, `ProjectInfo` and `ThreadStatusInfo` are plain data types owned by the SDK. They do not expose store shapes.
- Compatibility: `sdk.api` and `sdk.stores` stay as getters for this release. The first use by a plugin logs one warning that names the plugin and the replacement.
  The release note says that they go away in the next major version. The private marketplace plugins are not in this repository, so the shim is required.
- A manifest may declare `sdkVersion: 2`. The host gives a version 2 plugin an object with no `api` and no `stores`.
- The two bundled plugins move to version 2.

**Tests first**
- `plugins/facade.test.ts`: "docs.set calls the API with the bound plugin id" ; "a plugin cannot read the docs of another id" (no parameter exists; assert the call) ;
  "threads.list returns plain objects with the documented keys only" ; "threads.onChange fires on a status change and the returned function stops it" ;
  "navigate calls the navigation store".
- `plugins/sdk.test.ts` (add): "the first read of sdk.api by a v1 plugin warns once" ; "a v2 plugin object has no api and no stores key".
- `plugins/host.test.ts` (existing tests stay green; add): "a manifest with sdkVersion 2 gets the v2 object".
- The existing coach and previews tests under `packages/web/src/plugins/*.test.*` stay green after the move to version 2.

**Acceptance:** all web tests pass; in a worktree build with the isolated daemon, the Coach and Previews screens load with no deprecation warning.

**Effort:** M.

---

### W3-G: Diff review and a worktree choice per thread

**Covers:** product table #3.

**Owns**
- `packages/core/src/routes/git.ts`, new `packages/core/src/git/` (`diff.ts`, `worktree.ts`, tests)
- new `packages/web/src/components/inspector/DiffReview.tsx` and its test; one tab or menu entry in the inspector
- `packages/web/src/components/sidebar/NewThreadModal.tsx` (one option row), `packages/web/src/api/client.ts` and `api/types.ts` (append)

**Design**
- `GET /api/sessions/:id/git/diff?terminalId=&path=`: the diff of the thread's working directory against `HEAD`, with untracked files listed.
  `threadDiff(workDir: string, opts?: { path?: string; maxBytes?: number }): Promise<{ files: DiffFile[]; truncated: boolean; shared: boolean }>`
  with `DiffFile = { path: string; status: 'added' | 'modified' | 'deleted' | 'untracked' | 'renamed'; additions: number; deletions: number; patch?: string }`.
  `shared` is true when other live threads use the same directory; the UI then says that the changes can come from more than one thread.
- `POST /api/sessions/:id/git/approve { terminalId, paths: string[] }`: stages the paths (`git add`). It makes no commit.
- `POST /api/sessions/:id/git/discard { terminalId, paths: string[] }`: restores tracked files and removes the listed untracked files.
  It is `ownerOnlyStrict`. The UI asks for confirmation and names each file. It never runs a broad clean.
- Every path is checked with the existing confinement helpers and with `isSecretPath` (W1-B). `git` runs with an argument array, never through a shell.
- Worktree: `POST /api/sessions/:id/worktrees { name?: string }` runs `git worktree add <project>/.claude/worktrees/<slug> -b dispatch/<slug>`
  and returns `{ path, branch }`. The new thread modal has the option "Run in a new worktree". The path goes to the existing `workingDir` argument of thread creation
  (`SessionService.createTerminal`, the fifth parameter). No change in `sessions/service.ts`.
- When a thread with a worktree is deleted, the UI offers to remove the worktree. Dispatch never removes a worktree that has uncommitted changes.
- `DiffReview`: a file list with counts, a unified diff per file (reuse the existing diff view component), Approve and Discard per file and for all. It uses the W3-E primitives.

**Tests first** (each test makes a temporary git repository)
- `git/diff.test.ts`: "lists a modified, an added and an untracked file" ; "a path filter returns one file" ; "a large diff is cut and flagged" ; "shared is true when two live threads use the directory".
- `git/worktree.test.ts`: "creates the worktree and the branch" ; "a second call with the same name gets a new slug" ; "refuses outside a git repository with a clear error".
- `routes/git.test.ts` (add): "discard restores a tracked file and removes an untracked file" ; "discard refuses a path outside the working directory" ;
  "discard refuses a call with no credential and no browser headers" ; "approve stages only the listed paths".
- `inspector/DiffReview.test.tsx`: "shows the files with counts" ; "Discard asks for confirmation and names the file" ; "shows the shared-directory note".
- `sidebar/NewThreadModal.test.tsx` (add): "with the worktree option on, the create call carries the worktree path".

**Acceptance:** all tests pass; in the isolated instance with a temporary repository: start a thread in a worktree, change a file, see the diff, discard it.

**Effort:** M to L.

---

### 5.8 Wave 3 integration

**Order**
1. W3-C commit 1 (the move-only split of `useStructuredChat`): merge on the first day. It opens Gate 2.
2. W3-A. It opens Gate 1.
3. W3-E (independent; other streams then use the primitives).
4. W3-C (the rest).
5. W3-D.
6. W3-B (the largest diff in `sessions/`; merge after C and D so their small edits in `service.ts` are already in).
7. W3-F.
8. W3-G.

**Integrator tasks after the merges**
- Put `BootRecovery.run()` (W3-B) behind `Daemon.bootRecover()` (W3-A).
- Give `CoordinatorNotifier` the outbox and the journal as required inputs.
- Run the integration test plan of section 1A.4, and the three ratchet or guard tests.
- Bump the version in all four `package.json` files and write `docs/releases/v4.5.0.md` (see `docs/RELEASING.md`). The release note must name:
  the Doppler token scope, `DISPATCH_BIND`, the Cloudflare Access check, the deprecated `sdk.api` and `sdk.stores`, and the strict owner check on three routes.

**Known conflict points**

| File | Streams | Rule |
|---|---|---|
| `packages/core/src/server.ts` and `daemon/*` | A, then B | Gate 1. B changes only the `SessionService` construction and `wire-harnesses.ts`. |
| `packages/core/src/sessions/service.ts` | B (owner); C (callers of `updateStatus`), D (history-pageable answer) | C and D keep their edits in this file to single lines and list them in the hand-off. B merges after them. |
| `packages/core/src/ws/structured.ts` | C (first-frames block), D (replay body) | Regions are adjacent. Merge C first. |
| `packages/core/src/structured/*` | C (reads `turnOpen`), D (commit hook) | Single-line edits; merge C first. |
| `packages/core/src/db/schema.ts` | D (one appended migration) | Only D adds a migration in this wave. |
| `packages/web/src/components/tabs/chat/use*.ts` | C (socket, questions, busy), D (`useChatHistory`) | Gate 2. |
| `packages/web/src/api/client.ts`, `api/types.ts` | C, D, G | Append only. |
| `packages/web/src/theme.css` | E | New tokens only. |
| `packages/web/src/components/sidebar/NewThreadModal.tsx` | E (primitives), G (one option row) | Merge E first. |
| `packages/web/src/plugins/sdk.tsx` | F | F removes the plugin's direct use of `useUI`; the wrappers from W2-F stay until the next major version. |

---

## 6. Review focus

The final reviewer checks these points first.

**Security**
1. `isSecretPath` runs on the real path, on every read route that accepts an absolute path, and for every principal. Try a symbolic link, a path with `..`, and a case change on a case-insensitive disk.
2. The three strict routes still work from the web page and with a bearer token. No CLI command lost a call.
3. Doppler: an install with a saved connection and no `tokenScope` behaves exactly as before the upgrade. No MCP config file holds the token or a reference to it.
   The docs state the limit (same-user file access).
4. Cloudflare Access: with no config, the gate decisions are identical to the old code (compare with the existing gate tests). With the config, a missing or bad assertion gives the sign-in page, never an open door and never a lockout of a loopback caller.
   The verifier refuses `alg: none` and HMAC algorithms. The WebSocket upgrade path is covered.
5. The limiter cannot be emptied by a flood. `DISPATCH_BIND` unset gives the old listen call.
6. The discard route (W3-G) cannot remove a file outside the thread directory and never runs a shell.
7. JSON compression skips `no-store` responses.

**Data safety**
8. No code outside `ThreadConfigStore` writes the config column (guard test). `updateTab` with a partial config from an old cached web client does not delete keys.
9. Each new migration is ordered, has a unique name, and runs on a copy of a real database shape (use a fixture schema, never `~/.dispatch`).
10. The journal and the outbox remove their rows when a thread is deleted.

**Behaviour that must not change**
11. The conversation route returns byte-identical JSON for the same file (parity tests against the old code).
12. Ring compaction: a reconnect in the middle of a streamed message still shows the full message.
13. `createApp` tests pass with no edit after `buildDaemon`. `SessionService` keeps every public method.
14. Watches: a one-shot watch fires once per settle. A watcher is not woken twice by the second idle notification.
15. The old client path still works: no status frame gives the old busy fold; the synthetic settle frame is still sent.

**Owner rules**
16. No new `setInterval` or recurring `setTimeout` in the diff, except none. The stall check runs inside the existing 30 s tick. The outbox retries on events only.
17. No emoji in any UI string. Every new icon is a Phosphor icon.
18. `noAskStrip.test.ts` is green. The "Needs you" list has no Answer button and is not shown inside a thread. A restored question uses the same inline card.
19. The stall watchdog only flags. It has no access to a stop, kill or status function.
20. The visible name of the coordinator follows the setting everywhere a label was hardcoded. No folder, key or concept was renamed.

**Build and release**
21. A worktree build has no test files in `dist`. The daemon starts from that build in the isolated instance.
22. The linter warning ceiling did not go up. No `eslint-disable` was added without a reason comment.
23. The entry bundle is under the budget. An open tab from the earlier build still loads its chunks after a new build.
24. No command in any hand-off used port 3456, `~/.dispatch`, or the main checkout.

**Tests**
25. Each hand-off shows the tests-first evidence, both full suite results, the manual verification record and the numbers of section 1A.3. The only accepted failures are the 2 known ones in `routes/files.test.ts`.
26. Each regression test of section 1A.2 exists, and fails when its fix is reverted (check three of them by a revert in a scratch worktree).
27. W1-H: no code path refreshes or rewrites the CLI's own Claude credential. After a 429 or a 403 the next request waits for the back-off.

---

## 7. Deferred, needs owner

These items need a product decision by the owner. They are not in this program.

1. **One orchestrator model.** Merge Chat and the Control Plane, or give Chat project scope. Today five things start threads, and the Control Plane gets no reports from threads that Chat starts.
2. **One set of names.** The feature has four names: Control Plane (UI), Overseer (folder and one label), coordinator (config), Dispatch tab (code). "Agents" has four meanings.
   This program only makes the visible label follow the existing coordinator name setting.
3. **Settings sprawl.** Skills, Integrations, Secrets, Tools and Plugins as one area. This is a concept change.
4. **Auto-revive on a pending delivery.** Should a notice for a coordinator that is not running start that coordinator? The outbox keeps the notice and waits. The owner decides if it must wake the target.
5. **Diff review semantics.** This plan defines Approve as "stage the file" and makes no commit. The owner can choose a commit or a merge step.
6. **Doppler default for existing installs.** This plan keeps the scope "every thread" for an existing connection. The owner can choose to move existing installs to "only threads that I turn on" in a later release.
7. **Removal date of `sdk.api` and `sdk.stores`.** This plan keeps them with a warning. The owner sets the version that removes them, after the private marketplace plugins move.
8. **Usage figures for saved Claude accounts.** If W1-H confirms that the saved token cannot read usage because of its scope, real figures need a sign-in with a wider scope (for example a login folder per account, as Codex accounts have). That changes how a saved account signs in. The owner decides.

---

## 8. Follow-up, not in this program

These rows are in the review tables. The roadmap does not name them, and they are not needed by an approved item.

| Row | Reason |
|---|---|
| Daemon #8: move thread state out of the config into columns | Safe after W2-A; a separate migration project |
| Daemon #7: manual prune for the growth tables | Needs a retention rule for usage data; indexes and WAL tuning are in W1-E |
| Performance #9, #15: PTY output coalescing and routing; scrollback as Buffer chunks | PTY path; no approved item depends on it |
| Performance #10: keep 2 to 3 thread views mounted | Measure after W2-E and W3-C first |
| Performance #12: one endpoint for all terminals; the changed terminal in the event | Partly covered by W1-F; the endpoint is a separate API change |
| Performance #14: immutable, compressed plugin bundles in the service worker | Separate from the entry bundle work |
| Performance: chat virtualization | Named in the text, not in a table row; measure after W1-F |
| Reliability #6: confirm PTY delivery through `UserPromptSubmit` | Depends on the outbox (W2-C); a next step for the PTY path |
| Reliability #9: JSON logs with thread ids, log rotation | The panel and `doctor` are in W2-G |
| Reliability #10: recorded frames per CLI version | W2-D covers the fixtures that exist; a per-version recorder is new tooling |
| Reliability cause F: boot kickstart for Grok, OpenCode and PTY threads | The journal (W3-D) gives them history; a kickstart needs a per-harness turn record |
| Product #4: bulk actions on threads | Not in the roadmap |
| Product #6: one usage surface | Not in the roadmap; the area changes in this same release branch |
| Security: plugin isolation, pinned commits or signed tags for marketplaces | Not in the owner's security scope for this program |
| Security: peer uid check for local callers; device rows for Tailscale devices | L effort; the deny-list and strict checks (W1-B) cover the direct risk |
| The 513 empty `catch` blocks | W1-A adds the ratchet; the cleanup is gradual |

---

## 9. Effort summary

| Wave | Workstreams | Effort |
|---|---|---|
| 1 | A build health (S), B security boundaries (S–M), C Doppler and Cloudflare (M), D reliability (M), E daemon performance (M), F web render (M), G web safety and palette (M), H Claude account 403 and back-off (S–M) | about 2 weeks in parallel |
| 2 | A config store (M–L), B transcript reader (M), C outbox and boot recovery (M–L), D structured core (M–L), E bundle and markdown (M), F navigation and attention (M–L), G why panel (M) | about 3 to 4 weeks in parallel |
| 3 | A buildDaemon (L), B SessionService split (L, after A), C status authority (L), D journal (L), E UI primitives (M–L), F plugin SDK (M), G diff and worktrees (M–L) | about 4 to 6 weeks; A then B is the long path |


## 4A. Wave 2 additions: remote latency (Tailscale / Cloudflare), added 2026-11-09

Source: a Fable latency review of this branch (150 ms RTT model). Findings: a warm start still blocks on `theme-boot.js` (not served by the service worker, `max-age=0`, parser-blocking): 3 RTT; each thread open or tab switch opens a new WebSocket and empties the view (3–4 RTT); the boot sends about 14 fixed API calls plus one `terminals` call per project; the user's own message, archive and rename wait for the server; the daemon is HTTP/1.1 with Node's 5 s keep-alive, so direct `http://…:3456` pays a new connection after each 5 s pause; resume uses a 1.5 s pong wait and then remounts every thread view (full replay) on a slow cellular wake; structured replay frames under 1 KB are not compressed and Grok/OpenCode replay the full ring; the desktop terminal replay asks for 4 MB on each connect.

### W2-H: Remote launch latency

**Owns:** `packages/web/public/sw.js`; `packages/web/src/main.tsx` (the `watchForUpdates` function only); new `packages/core/src/routes/bootstrap.ts` + test; one mount line in `server-routes.ts`; new `packages/web/src/lib/bootstrap.ts` + test; `packages/web/src/lib/resync.ts`; `packages/core/src/server.ts` (two lines after `http.createServer`: `keepAliveTimeout = 75_000`, `headersTimeout = 76_000`); `packages/core/src/routes/plugins.ts` (`pluginAssetHandler` only); `packages/web/src/plugins/host.ts` (`loadPlugins` only); one line in the `App.tsx` boot effect (merge after W2-F).

**Design:**
- Service worker serves `theme-boot.js` and `manifest.webmanifest` cache-first then refreshes; bump `VERSION`; make path tests relative to the SW scope (works under `DISPATCH_BASE_PATH`).
- `GET /api/bootstrap` → `{ sessions, terminalsByProject, stalls, authRequests, update, usageSummary, sharedSettings, plugins, schedules }`. Each part applies the same redaction and key rules as its own route (a thread key gets 403). Compressed by W1-E. `loadBootstrap()` fills the stores; on 404 (older daemon) it falls back to today's calls. `resyncAfterReconnect` uses one all-projects terminals call.
- After a shell refresh with a new entry name, the SW fetches the new entry + CSS, then posts `shell-updated`; at idle it warms the lazy chunks listed in the Vite manifest.
- Plugin file with `?v=` equal to the current stamp: `immutable` + br/gzip; without `?v=`: `no-cache` as today.

**Tests first:** `sw.test.js`: "theme-boot.js comes from the cache with no network wait", "a new shell stores the new entry chunk before the message", "an /api path is not handled". `routes/bootstrap.test.ts`: "each part equals its own route", "a thread key gets 403", "a body over 1 KB is compressed". `lib/bootstrap.test.ts`: "one request fills the stores", "a 404 uses the old calls". `lib/resync.test.ts`: "a reconnect sends one request for 20 projects". `routes/plugins.test.ts`: "a current stamp gives immutable and an encoding", "an old stamp gives no-cache". Server: "keepAliveTimeout is 75000".

**Acceptance:** isolated instance, 150 ms added latency (CDP): a warm launch paints the list with 0 blocking requests; one bootstrap request at launch; one list request at reconnect. Before/after request counts and time-to-list in the hand-off. **Effort:** M.

### W2-I: Thread open and action latency

**Owns:** `packages/web/src/components/tabs/chat/useStructuredChat.ts` (the reset block and `send` only); new `packages/web/src/lib/threadViewCache.ts`; `packages/web/src/api/structured-socket.ts`, `terminal-socket.ts`, `events-socket.ts`; `packages/core/src/ws/structured.ts` (the replay loop), `ws/terminal.ts` (the replay send), `ws/client-wss.ts`; `stores/tabs.ts` and `stores/projects.ts` (new optimistic `archive` and `rename` actions) and their callers in `ThreadMenu.tsx`, `ProjectCard.tsx`, `AllThreadsView.tsx`, `CommandPalette.tsx`; `App.tsx` (the `useResume` block only).

**Design:**
- `threadViewCache`: `get(id)`/`put(id, items)`, 20 threads × 300 items, memory only. On open/switch the view shows cached items at once (marked stale); the first replay replaces them with no duplicates.
- Optimistic send: a local `user` item with `localId`; the next `user` event with the same text replaces it; a failed POST marks it failed (retry offered).
- `useTabs.archive(id)` / rename remove or change the row first; on error `loadTabs` and a hint.
- `?batch=1` on the structured socket: the replay is one frame `{ type: 'replay', events: [...] }`, compressed; older clients get today's frames. Live events that arrive during the replay are sent after it, in order.
- Terminal socket negotiates deflate; the replay frame is compressed, live frames are not; desktop starts at 1 MB and uses the phone step-up path.
- Resume: `checkAlive(4000)`; a failed check reconnects the sockets without bumping `reconnectGen` (no remount); a socket in `CONNECTING` for 8 s closes and retries.

**Tests first:** `threadViewCache.test.ts`: "the 21st thread removes the oldest". `useStructuredChat` tests: "a switch back shows cached items before the socket opens", "a replay replaces cached items with no duplicate", "a sent message shows before the echo, and the echo does not add a second one", "a failed POST marks the bubble". `stores/tabs.test.ts`: "archive removes the row before the request ends", "a failed archive puts the row back". `ws/structured.test.ts`: "batch=1 sends one frame with the same events in order", "no batch parameter keeps the old frames", "a live event during the replay arrives after it". `ws/terminal.test.ts`: "the replay frame is compressed and a live frame is not". `events-socket` test: "a socket in CONNECTING for 8 s closes and tries again".

**Acceptance:** with 150 ms added latency: a tab switch back shows content in the same frame; a sent message shows in the same frame; replay bytes for a 200-event Claude thread and a 4 MB terminal before/after in the hand-off. **Effort:** M–L.

**Integration order for Wave 2 with these:** … W2-E, W2-F, then W2-H, then W2-I (W2-I rebases on W2-D's ring changes and W2-F's App.tsx).
**Wave 3 note:** W3-D gives each item a `seq`; add a resume cursor (`?after=seq`) to its design. Carrying the structured streams on the events socket (one socket per page) is a Wave 3 item after W3-C.
