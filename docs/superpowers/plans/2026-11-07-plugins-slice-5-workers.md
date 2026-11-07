# Plugins slice 5: workers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin may ship a worker: a process the daemon runs while the plugin is enabled, restarts with backoff, logs to a file the Plugins page shows, feeds with the daemon's events and with cron jobs, and exposes through a proxied Unix socket so the web part (and other plugins) can call it.

**Architecture:** `PluginWorkers` (core) owns one child per enabled plugin with `worker.command`, started like a hook script (the daemon's filtered env plus the plugin identity and key file), its stdout and stderr appended to `<logDir>/plugins/<id>.log` (rotated at 5 MB). The daemon writes events to the worker's **stdin** as NDJSON (the thread events, redacted per permissions; the plugin's own `plugin:data` and `plugin:settings`; `plugin:job { id }` on the job's cron), because no key may open a WebSocket (spec section 6.4; the spec's "subscribes to /api/events" is replaced by this feed, ruling below). A worker may listen on the socket path the daemon gives it; `/api/plugins/<id>/worker/*` is proxied to it with the caller's principal in headers. Jobs use a five-field cron subset evaluated once a minute.

**Tech Stack:** as before; `node:http` over `socketPath` for the proxy; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-07-plugins-design.md` sections 1 (manifest `worker`), 4, 6 (keys), 9 (only `plugin_logs` is relevant; the agent tools move to slice 6 — ruling).

## Global Constraints

- A worker runs only while its plugin is enabled and loadable; disable, remove, a broken manifest or daemon shutdown stop it (SIGTERM, SIGKILL after 3 s).
- The worker's env is `inheritedEnv()` plus `DISPATCH_PLUGIN`, `DISPATCH_PLUGIN_AUTH_FILE`, `DISPATCH_API`, `DISPATCH_PLUGIN_SOCKET`, and the manifest's `worker.env`; never the daemon's own key or box token.
- Restart on exit with backoff 1 s, 2 s, 4 s … capped at 60 s; a run that lasts 60 s resets the backoff; after 10 crashes in a row the worker stays stopped ("crashed", the page offers Restart).
- The log file is `<platform.logDir()>/plugins/<id>.log`, appended, rotated to `.1` at 5 MB; the page shows the last 200 lines.
- The event feed to stdin carries `thread:*` events redacted like hooks (no prompt text without `read:prompts`), the plugin's own `plugin:data` / `plugin:settings`, and `plugin:job`; a worker that does not read its stdin must not block the daemon (write errors are dropped; the pipe is not awaited).
- Cron: five fields (`min hour dom mon dow`), `*`, lists, ranges, steps; evaluated in local time once a minute; a job missed while the daemon was down is not replayed.
- The proxy forwards method, path, query, headers (minus `Authorization`, `Cookie`), and body; adds `X-Dispatch-Principal` (`owner`, `thread:<terminalId>`, `plugin:<id>`) and `X-Dispatch-Session` when known; a missing socket answers 502 `no_worker`; the route policy: owner, the plugin's own key, and thread keys only when the plugin grants `threads:call-worker` (a new permission).

## Review Focus

1. A worker that exits immediately in a loop must back off and stop after ten tries, and never spin the daemon (Task 2 test "a crash loop backs off and stops after ten").
2. A worker that never reads stdin must not block the daemon or grow memory without bound (Task 2 test "an unread stdin never blocks"; the write queue is capped).
3. A plugin without `read:prompts` must see no prompt text in its feed (Task 2 test "the feed is redacted like hooks").
4. The proxy must not forward the caller's `Authorization` or cookie to the worker, and a thread key without the grant must get 403 (Task 3 tests).
5. Disable while a request is being proxied must answer the client (502 or the worker's answer), never hang (Task 3 test "disable mid-request").

---

### Task 1: Manifest `worker` and the cron subset

**Files:**
- Modify: `packages/core/src/plugins/manifest.ts` (`PluginWorker { command: string; args?: string[]; env?: Record<string,string>; jobs?: { id: string; cron: string }[] }`, `parseWorker` like `parseModel`: a bad shape is a manifest error naming the field)
- Create: `packages/core/src/plugins/cron.ts` (`parseCron(expr): CronSpec | null`, `cronMatches(spec, date: Date): boolean`, `nextCronRun(spec, from: Date): Date | null` (within 366 days))
- Test: `packages/core/tests/plugins/manifest.test.ts` (add), `packages/core/tests/plugins/cron.test.ts`

- [ ] Tests: 'worker parses command, args, env and jobs; a job without id or cron, a bad cron, or a command that is not a string is an error'; cron: '`0 7 * * 1-5` matches 07:00 on weekdays only', 'steps and lists (`*/15 9-17 * * *`, `0 9,13 * * *`)', 'an invalid field is null', 'nextCronRun finds the next minute and null when none within a year'.
- [ ] Implement; commit `feat(core): plugin worker manifest and a cron subset`.

### Task 2: PluginWorkers: supervision, logs, the event feed, jobs

**Files:**
- Create: `packages/core/src/plugins/workers.ts` (`PluginWorkers(registry, threadEvents, { logDir, runDir, api: () => string, now?, timers? })`: `sync()` (start the enabled ones with a worker, stop the rest; the registry calls it from `announce` through `setWorkerSync`), `stats(id): WorkerStats | null` (`{ state: 'running' | 'backoff' | 'stopped' | 'crashed'; pid: number | null; restarts: number; startedAt: string | null; lastExit: { code: number | null; signal: string | null; at: string } | null; socket: string | null }`), `restart(id)`, `logTail(id, lines)`, `stop()`; the feed: `write(id, event)` with a per-worker queue capped at 500 lines; `emitJob(id, jobId)`; a one-minute ticker that evaluates every enabled plugin's jobs)
- Modify: `packages/core/src/plugins/registry.ts` (`setWorkerStatsProvider`, rows gain `worker?: WorkerStats`; `announce` calls the worker sync), `packages/core/src/server.ts` (construct after PluginHooks in both builds; `stop()` in cleanup; `platform.logDir()`; `runDir = <dataDir>/run`)
- Test: `packages/core/tests/plugins/workers.test.ts` with a fake worker script written by the test (echoes its stdin lines to a file; `--crash` exits 1 at once; `--ignore-stdin` never reads; `--socket` listens on `DISPATCH_PLUGIN_SOCKET` and answers)

- [ ] Tests: 'an enabled plugin with a worker starts it with the plugin env and its key file; disable stops it (SIGTERM) and the row says stopped'; 'stdout and stderr land in the log file and logTail returns the last lines; a 5 MB file rotates to .1'; 'a crash loop backs off and stops after ten; restart() starts again and resets the count' (fake timers); 'the feed is redacted like hooks and carries the plugin's own plugin:data only'; 'an unread stdin never blocks (the queue caps at 500 and the daemon keeps answering)'; 'a job fires plugin:job on its cron minute and not twice in the minute' (fake clock).
- [ ] Implement; commit `feat(core): plugin workers — supervision, logs, event feed, jobs`.

### Task 3: The socket proxy

**Files:**
- Modify: `packages/core/src/routes/plugins.ts` (`router.all('/plugins/:id/worker/*', rule, proxy)`; `GET /plugins/:id/logs?lines=200` (owner); `POST /plugins/:id/worker/restart` (owner)), `packages/core/src/auth/key-rules.ts` or the plugin rules in the router (`threads:call-worker` grant rule), `packages/core/tests/auth/route-policy-completeness.test.ts`
- Test: `packages/core/tests/routes/plugins-worker.test.ts` (a fake worker listening on a socket)

- [ ] Tests: 'the owner's request reaches the worker with method, path, query and body, and X-Dispatch-Principal: owner; the answer streams back with its status and headers'; 'Authorization and Cookie are not forwarded'; 'a thread key gets 403 without threads:call-worker and the principal header thread:<id> with it; the plugin's own key is plugin:<id>'; 'no worker: 502 no_worker'; 'disable mid-request answers the client'; 'logs returns the tail for the owner only; restart restarts'.
- [ ] Implement; commit `feat(core): worker proxy, logs and restart routes`.

### Task 4: The Plugins page and the SDK

**Files:**
- Modify: `packages/web/src/api/types.ts` (`WorkerStats` on `PluginRow`), `packages/web/src/api/client.ts` (`pluginLogs(id, lines)`, `restartPluginWorker(id)`), `packages/web/src/components/settings/PluginsSection.tsx` (a worker chip: Running · pid · N restarts / Backing off / Crashed (red, with the last exit) / Stopped; buttons Restart and Logs; Logs opens a Modal with the tail in a `<pre>`, refreshed every 2 s while open), `packages/web/src/plugins/sdk.tsx` (`d.worker.fetch(plugin, path, init)` → `/api/plugins/<id>/worker/<path>` with the plugin header), `docs/plugins.md` (a Worker section: the manifest, the env, the stdin feed format, jobs, the socket and the proxy, logs)
- Test: `PluginsSection.test.tsx` (add: the chip states and the Logs modal), `sdk.test.ts` (add: `worker.fetch` path)

- [ ] Tests, implement, commit `feat(web): worker status, logs and restart on the Plugins page; d.worker.fetch`.

### Task 5: Example, suites, e2e

- [ ] `docs/plugins/examples/daily-rundown` gains a worker (`worker/index.js`: a job at 07:00 that writes the rundown document; a socket that answers `/health`) and the README shows the feed format.
- [ ] Full suites.
- [ ] E2E on an isolated daemon with a local worker plugin: the log file fills, the page shows Running, a `--crash` variant shows Crashed after the backoff run, Restart works, a job with `* * * * *` fires within a minute (`plugin:job` seen in the log), the proxy answers `/health` through `d.worker.fetch` from the browser console, disable stops the process (no pid left).
