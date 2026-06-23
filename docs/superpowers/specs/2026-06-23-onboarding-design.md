# Dispatch Onboarding — Design

**Date:** 2026-06-23
**Status:** Approved (design); ready for implementation plan
**Audience for the feature:** developers self-hosting Dispatch on their own Mac

## Goal & Success Criteria

A developer on a fresh Mac goes from zero to driving a coding agent **from their phone**
in one paste plus a short guided wizard.

Concretely, success is:

1. `curl -fsSL <public-url> | sh` → the launchd daemon is running on `:3456`, the app opens at `http://localhost:3456`.
2. A first-run wizard walks three steps: **Agents** (claude/codex), **Mobile** (Tailscale), **Secrets** (Doppler, optional).
3. After the wizard, the user can reach Dispatch from their phone over Tailscale.
4. Nothing in the wizard is mandatory — every step is skippable / non-blocking.
5. The wizard is re-openable from Settings, and a `dispatch doctor` CLI prints the same status.

Non-goals (v1): public internet exposure, Cloudflare automation, a packaged `.app`, a hosted
multi-tenant service, a built-in secrets vault.

## Decisions (resolved during brainstorming)

- **Distribution model:** self-host on the user's own Mac (Dispatch needs local filesystem
  access + each user's own agent logins; it cannot meaningfully be hosted centrally).
- **Setup mechanism:** one-line installer **+** in-app first-run wizard (Approach #1).
- **Mobile access:** **Tailscale** (private device mesh). No public listener is added. This keeps
  the security model network-gated with no auth gateway to configure.
- **Secrets:** keep the existing **Doppler** integration as an **optional, skippable** wizard step.
  No new secrets backend.
- **Providers:** **detect + guide + re-check** — never auto-mutate the user's global npm; logins
  are interactive anyway.
- **Repo:** going **public** so `curl | sh` can pull the installer + source directly (requires a
  git-history secret audit first — see Prerequisites).
- **Install location:** `~/.dispatch/app`.
- **v1 Tailscale scope:** display the reachable URL + QR only. Writing the tailnet URL into the
  server-switcher list (`DISPATCH_SERVERS`) is deferred to a later iteration.

## Architecture

Three units around one shared detection core, so the same logic backs both the HTTP API and the CLI.

### 1. Shared detection module — `packages/core/src/setup/detect.ts`

Pure, side-effect-light functions returning plain data. Used by the HTTP routes and the CLI.

- `detectProvider(name: 'claude' | 'codex'): { installed: boolean; version?: string; signedIn: boolean | 'unknown' }`
  - `installed`: resolve the binary on the daemon user's PATH (`which`/`command -v`).
  - `version`: best-effort (`<bin> --version`), non-fatal.
  - `signedIn`: best-effort heuristic from credential/config files (e.g. `~/.claude` credentials,
    `~/.codex/auth`). When indeterminate, return `'unknown'` — it must never block the wizard.
- `detectTailscale(port: number): { installed: boolean; running: boolean; dnsName?: string; url?: string }`
  - Locate the binary including the app bundle path `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
  - Run `tailscale status --json` with a ~2s timeout; parse `Self.DNSName` (MagicDNS).
  - `url = http://<dnsName>:<port>` when running + MagicDNS available.
- `detectSecrets(): { connected: boolean }` — delegates to the existing `SecretsService` status.
- `setupState(port): { firstRun: boolean; providers: {...}; tailscale: {...}; secrets: {...} }` — aggregate.

`firstRun` is derived from a persisted `setup_completed_at` (see Persistence).

### 2. Backend routes — `packages/core/src/routes/setup.ts`

Mounted alongside the existing routers in `server.ts` (and `startServer`'s app).

- `GET  /api/setup/state` → full `setupState()`.
- `GET  /api/setup/providers` → on-demand provider re-check.
- `GET  /api/setup/tailscale` → on-demand Tailscale re-check.
- `POST /api/setup/complete` → persist `setup_completed_at` (dismiss first-run).
- Secrets continue to use the existing `/api/secrets*` routes unchanged.

**Persistence:** store `setup_completed_at` using the simplest existing mechanism — a settings/meta
row if one exists, otherwise a small `~/.dispatch/setup.json`. (Confirm during planning which the
codebase already has.)

### 3a. First-run wizard (web) — `packages/web/src/components/setup/SetupWizard.tsx`

- The app shell fetches `GET /api/setup/state` on load. If `firstRun` and not dismissed this
  session, render the wizard as an overlay that works on desktop **and** mobile.
- Steps:
  1. **Agents** — a status row per provider (installed / signed-in badges). If a CLI is missing or
     signed out, show the exact `npm i -g …` install command and `… login` command with copy
     buttons, plus a **Re-check** button (re-fetches `/api/setup/providers`). "Continue" is always
     enabled (non-blocking).
  2. **Mobile (Tailscale)** — if not installed/running, show install guidance
     (`brew install --cask tailscale` or the App Store) + **Re-check**. Once up, show the tailnet
     URL `http://<dnsName>:3456` **and a QR code** to open it on the phone, plus the instruction to
     install the Tailscale app on the phone and sign into the same account.
  3. **Secrets (Doppler, optional)** — reuse the existing Settings→Secrets connect UI (token +
     project/config) with a prominent **Skip**.
  - Final screen: a short "you're set" summary; note it can be reopened from Settings.
- **Re-entry:** a "Getting started" / "Setup" entry in Settings reopens the wizard at any time.
- **QR code:** generated client-side with a small QR library (e.g. `qrcode`), rendered to a canvas/SVG.

### 3b. `dispatch doctor` CLI

- New `bin/dispatch` subcommand that prints a colored checklist of the same statuses.
- Implementation: query the running daemon's `GET /api/setup/state` when up; otherwise call a tiny
  node entry that uses the shared `detect.ts` module directly. (Reuses detection; no duplicate logic.)

### 4. One-line installer — `scripts/install.sh`

Harden the existing script; serve via `curl -fsSL <public-url> | sh` from the public repo.

Idempotent, re-runnable, each step guarded:

1. Preflight: macOS check; ensure git / Xcode Command Line Tools; ensure Node ≥18; ensure pnpm
   (via `corepack enable`). Missing required tools → clear message + safe exit.
2. Clone the repo to `~/.dispatch/app` (or `git pull` if already present).
3. `./bin/dispatch build` then `./bin/dispatch install` (launchd).
4. Symlink `bin/dispatch` onto PATH (`/usr/local/bin` or `~/.local/bin`); non-fatal if it fails.
5. `open http://localhost:3456`; print a next-steps banner pointing at the wizard.

Provide a `--check` dry-run mode for testing.

## Data Flow

Wizard / CLI → `/api/setup/*` → `detect.ts` (spawns `which`, `tailscale status`; reads cred files)
+ `SecretsService`. Completion is persisted server-side. Secrets never leave the server — the
Doppler token stays in the existing 0600 `~/.dispatch/doppler.json`.

## Error Handling

- Detection never throws to the client: a missing binary → `installed:false`; a failed or timed-out
  command → `signedIn:'unknown'` / `running:false`. `tailscale status` is bounded by a ~2s timeout.
- Every wizard step is skippable; nothing is required to finish.
- Installer steps are individually guarded and the whole script is safe to re-run; optional steps
  (e.g. the PATH symlink) failing must not fail the install.

## Security

- Mobile access is **Tailscale-only** (device-gated). The design adds **no** public listener and the
  docs keep the "never expose `:3456` raw to the internet without a gate" warning.
- **Prerequisite before making the repo public:** audit git history for any committed secrets
  (a Global API Key was reportedly pasted in a past session) and scrub if present.

## Testing

- **Unit** — `detect.ts` with mocked `exec`/`fs`: claude/codex present vs absent vs signed-in vs
  signed-out; Tailscale up vs down vs missing; URL formatting from `DNSName`.
- **Routes** — `/api/setup/*` response shapes, mirroring the patterns in `packages/core/tests/routes/`.
- **Web** — `SetupWizard` step rendering, Re-check, and Skip (vitest + RTL, matching existing web tests).
- **Installer** — `--check` dry run for assertions; manual end-to-end on a clean macOS user/VM.

## Phasing (each phase ships independently)

1. Shared `detect.ts` + `GET /api/setup/state` + `dispatch doctor`.
2. `SetupWizard` scaffold + **Agents** step + first-run gating + Settings re-entry.
3. **Mobile/Tailscale** step (detect + URL + QR).
4. **Secrets** step (wraps the existing Doppler UI).
5. Installer hardening + public-repo prep (secret audit) + chosen public install URL.

## Open Prerequisites

- Make the repo public **after** the git-history secret audit.
- Pick the install URL: raw GitHub on the public repo vs a vanity domain (e.g. `get.dispatch…`).
