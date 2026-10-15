# Anonymous usage telemetry — design

Date: 2026-10-15. Ships in 3.0.0 (branch `feat/endless-chat`).

## Goal

Know how many installs use Dispatch each day, which versions they run, and how much
they use it (turns and token totals). Nothing else.

## Decisions (from the user)

- On by default. A toggle in Settings → General turns it off.
- No notice: the release notes and the README do not mention it. The toggle and the
  code stay plainly labelled; nothing is obfuscated.
- No personal data, no prompts, no content, no project names or paths.
- Service on `dispatchd.app` (Cloudflare account `d02ecc2fed211574398816b35aa68880`,
  zone active). Dashboard at `/stats` behind Cloudflare Access; the owner sets up the
  Access app by hand (the wrangler OAuth login has no Access scope).

## Part 1 — the daemon

New folder `packages/core/src/telemetry/`:

- `install-id.ts` — a random UUID made once and kept in `app_state`
  (`telemetry_install_id`). It is not derived from the machine, the user, or any account.
- `payload.ts` — builds the report from the local DB. Pure function, unit-tested.
- `sender.ts` — the loop and the POST.

### The report

`POST https://dispatchd.app/v1/ping`, JSON, at most 4 KB:

```json
{
  "v": 1,
  "installId": "uuid",
  "version": "3.0.0",
  "platform": "darwin" | "wsl",
  "days": [
    {
      "day": "2026-10-15",
      "providers": { "claude": { "turns": 12, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
      "threads": 4,
      "chatTurns": 3
    }
  ],
  "projects": 5
}
```

- `day` is the UTC date. Totals come from `usage_turns` rows whose `started_at` falls in
  that UTC day, grouped by `provider`. Provider keys are limited to the known set
  (`claude`, `codex`, `opencode`, `grok`, `other`); any other value folds into `other`.
- `threads`: distinct `terminal_id` in those rows. `chatTurns`: Endless Chat user messages
  logged that day (`endless_messages` rows of kind `user`; 0 when Chat is unused). `projects`: count of projects (sessions), a plain number.
- No model names, no project ids, no terminal ids, no costs, no text of any kind.
  The only strings are `installId`, `version`, `platform`, the day, and the provider keys.

### When it sends

- A check runs 60 s after boot and then every hour.
- The daemon records `telemetry_alive_day` (UTC) on each check.
- A check sends when the last successful send was more than 6 hours ago, or on the
  first check of a new UTC day.
- `days` holds today (totals so far). It also holds yesterday, with final totals, when
  `telemetry_alive_day` was yesterday before this check — so the last hours of a day
  are not lost, and an install that was off yesterday is never counted active for it.
- A failed send is silent (one `console.warn` at most per day) and is retried on the
  next check. A 5 s timeout. Telemetry never throws into the daemon and never blocks boot.

### Off switches

- Setting `telemetry_enabled` in `app_state`; absent means on. The General section gets a
  last row: **Send anonymous usage stats** (switch), the last row at the bottom of the section. Turning it off stops sends at the
  next check; no request is made while it is off.
- `DISPATCH_TELEMETRY=0` in the daemon environment disables it regardless of the setting.
  The test copy on port 3999 and the test suite set it.
- Endpoint override `DISPATCH_TELEMETRY_URL` (for the live test only).

## Part 2 — the service

New folder `services/telemetry/` (not in the pnpm workspace build of the daemon):
`wrangler.toml`, `src/index.ts`, `schema.sql`, tests with vitest.

- Worker `dispatch-telemetry`, route `dispatchd.app/*`, D1 database `dispatch-telemetry`.
- Table `pings(install_id TEXT, day TEXT, version TEXT, platform TEXT, providers TEXT,
  threads INTEGER, chat_turns INTEGER, projects INTEGER, received_at TEXT,
  PRIMARY KEY(install_id, day))`. A second report for the same install and day replaces
  the first (upsert).
- `POST /v1/ping`: rejects bodies over 4 KB, a wrong `v`, a non-UUID `installId`, a
  `version` that is not semver, an unknown `platform`, more than 2 days, a day more than
  2 days from the server's UTC date, unknown provider keys, and non-integer or negative
  numbers. Returns 204 on success, 400 on a bad body. It stores no IP and no headers.
- `GET /stats` (behind Access): one server-rendered HTML page, no external scripts:
  daily active installs (30 and 90 days), installs per version (last 7 days), turns and
  output tokens per provider per day (30 days), platform split, and totals.
  `GET /stats.json` returns the same numbers for later use.
- Every other path returns 404.

## Part 3 — Cloudflare Access (manual, by the owner)

One self-hosted Access application covering `dispatchd.app/stats` and
`dispatchd.app/stats*`, one Allow policy with the owner's email, login by one-time PIN.
`/v1/ping` stays public.

## Tests

- Daemon: payload shape from a seeded DB (only the allowed strings appear; unknown
  provider folds to `other`; yesterday included only when alive yesterday); sender
  cadence with fake timers; setting off and `DISPATCH_TELEMETRY=0` make no request;
  a failing fetch does not throw.
- Worker: validation cases, upsert of the same install/day, stats aggregation.
- Live: deploy, send one test ping with `DISPATCH_TELEMETRY_URL`, see it in `/stats`
  (after Access is set up), delete the test row.

## Out of scope

Per-user identity, model names, costs, error reports, crash logs, retention jobs.
