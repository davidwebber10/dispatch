# Bundled CLI Tools — Design

**Date:** 2026-06-26
**Status:** Approved (design)

## Problem

Dispatch threads run `claude` / `codex` as PTY processes that inherit the daemon's environment, so the agent can already shell out to any CLI on the daemon's `PATH`. But that means capabilities depend on whatever the host machine happens to have installed, there's no curated/reproducible set, and the agent often doesn't *know* a tool is available so it never reaches for it. We want Dispatch to **ship a curated set of CLIs** (plus an easy way to add your own) that are reliably available in every thread, authenticated, and advertised to the agent — a new integration vector complementing the existing MCP layer.

## Goals

1. The agent can call a curated set of CLIs (`jq`, `ripgrep`, `gh`, `doppler`, `databricks`, `@shopify/cli`, `aws`) in any thread, with **no per-machine install** — Dispatch brings them.
2. **Default bundle + add-your-own:** a shipped default set, extendable by adding entries to a user file; adding a tool is one JSON entry.
3. Tools are **authenticated** (primarily via the existing Doppler env; per-tool config where env isn't enough).
4. The agent is **told which tools exist** (an awareness note injected per provider).
5. A **read-only Settings view** shows each tool's installed/authed status.

## Decisions (from brainstorming)

- **Capability expansion**, not just MCP: tools live on a thread-visible `PATH`; the agent decides when to use them.
- **Managed prefix:** Dispatch owns `~/.dispatch/tools/` (a `bin/` prepended to every thread's `PATH`); isolated from system brew/global npm, Dispatch-controlled versions, clean uninstall.
- **Manifest = default bundle (in repo) merged with user `~/.dispatch/tools.json`.** Adding a tool = one entry.
- **Install kinds:** `binary` (download + optional sha256 verify + extract + place), `npm` (`npm i --prefix`), `script` (run an install command targeting the prefix — for bundle-installer tools like aws v2).
- **Auth:** Doppler env by default (+ optional `envAlias` to remap a secret to the var a CLI expects), with an optional `configFile` template escape hatch for CLIs that can't read env. No secrets persisted to disk at rest beyond what a `configFile` tool explicitly needs.
- **Awareness injection (asymmetric, per provider):**
  - **Claude** → reuse the existing `--append-system-prompt` channel (`claude-code.ts` already injects `composeInjection`'s `systemPrompt`). The tools note is folded in. No file mutation.
  - **Codex** → `-c developer_instructions="<note>"`. Per the Codex config schema, `developer_instructions` is *"inserted as a `developer` role message"* — additive, layered on top of Codex's sanctioned base prompt, **not** a replacement, and **no filesystem write** (no repo `AGENTS.md` mutation). Chosen over `model_instructions_file` (which *overrides* the built-in prompt and is "STRONGLY DISCOURAGED") and over `AGENTS.md` (user rejected repo-FS injection). Codex has no `--append-system-prompt`; `experimental_instructions_file` doesn't exist in 0.142.2.
- **Read-only Settings "Tools" view** (status only); editing is via `tools.json` + `dispatch tools` commands.
- **Platform:** macOS `arm64`/`x64` (matches the launchd daemon). Linux/Windows out of scope (follow-up).

## Architecture / components

### Prefix & PATH (`packages/core/src/tools/paths.ts`, `pty/manager.ts`)
- `~/.dispatch/tools/`: `bin/` (executables/symlinks on the thread PATH), `pkgs/` (npm prefix internals + script-kind install dirs), `cache/` (downloads), `installed.json` (name → installed version + resolved sha, for idempotency).
- `pty/manager.ts` `spawn`: prepend `<toolsBin>` to `childEnv.PATH`, and merge per-tool spawn env (see Auth). The env assembly is extracted into a testable helper.

### Manifest (`packages/core/src/tools/manifest.ts`, `default-tools.json`)
Effective manifest = `default-tools.json` (shipped) merged with `~/.dispatch/tools.json` (user; user entries override/extend by `name`). Entry schema:
```ts
interface ToolEntry {
  name: string;                 // "gh"
  description: string;          // one-line, for the awareness note
  kind: 'binary' | 'npm' | 'script';
  binary?: { [platform: string]: { url: string; sha256?: string; archive?: 'tar.gz' | 'zip' | 'none'; binPath?: string } };
                                 // platform key = "darwin-arm64" | "darwin-x64"; sha256 optional (verified if present)
  npm?: { package: string; version?: string };
  script?: { install: string };  // shell run with TOOLS_PREFIX + TOOLS_BIN env set; must place bins in $TOOLS_BIN
  bins: string[];               // executables this provides (verification + symlinking)
  authEnv?: string[];           // env vars that, present, mean "authed" (["GH_TOKEN"] / ["DATABRICKS_HOST","DATABRICKS_TOKEN"])
  envAlias?: Record<string, string>; // set <key> from process.env[<value>] at spawn (CLI-expected var ← Doppler secret name)
  configFile?: { path: string; template: string }; // rendered from env at spawn for non-env CLIs (escape hatch)
  docs?: string;
}
```
`loadManifest()` validates entries (name/kind/bins required; kind-specific fields present) and drops invalid ones with a logged warning (one bad entry never breaks the set).

### Installer (`packages/core/src/tools/installer.ts`)
`installTool(entry)`:
- `binary`: pick the host-platform asset; download to `cache/` via an injectable `download(url) => Buffer` (hermetic tests); if `sha256` present, verify (mismatch → abort that tool); extract per `archive`; place `binPath` (or the lone binary) into `bin/`, chmod 0755.
- `npm`: `npm i --prefix ~/.dispatch/tools/pkgs <package>@<version>`; symlink `pkgs/node_modules/.bin/<bin>` → `bin/<bin>`.
- `script`: run `script.install` with `TOOLS_PREFIX`/`TOOLS_BIN` set; verify the declared `bins` now resolve in `bin/`.
- Idempotent: skip when `installed.json` shows the same name+version (and sha) already present.
`uninstallTool(name)` removes its bins/dirs and the `installed.json` record.

### CLI (`packages/core/src/tools/cli.ts`, `bin/dispatch`)
`node dist/tools/cli.js <cmd>`, dispatched from `bin/dispatch tools …`:
- `install [name]` — install all (or one) from the effective manifest.
- `list` / `status` — table: name · installed? · version · authed? · kind.
- `uninstall <name>`.
`bin/dispatch build` and `dispatch update` call `tools install` so tools arrive/update with Dispatch (failures are reported but don't abort the daemon build).

### Status & awareness (`packages/core/src/tools/status.ts`, `awareness.ts`)
- `toolStatuses()` → per tool `{ name, description, installed, version?, authed, kind, docs? }` (`installed` = bin exists in `bin/`; `authed` = all `authEnv` present in the daemon env).
- `awarenessNote(statuses)` → a short markdown section listing *installed* tools (`- gh — GitHub CLI` + `(needs GH_TOKEN)` when unauthed). Empty string when none installed.

### Spawn-time injection (`sessions/service.ts`)
At thread spawn, after building the provider command:
- Compute `awarenessNote` once.
- **Claude:** pass the note into the system-prompt path (append to `composeInjection`'s `systemPrompt`, e.g. as an additional `prompts[]` entry) so it rides the existing `--append-system-prompt`.
- **Codex:** add `-c developer_instructions=<toml-string>` to the codex args (in `providers/codex.ts`, alongside the existing `mcpArgs`/`hookArgs`). The note is TOML-encoded into a basic string (escape `"`, `\`, newlines); since args are passed via node-pty argv there is no shell-escaping concern. No file is written. When the note is empty (no installed tools) the flag is omitted.
- Merge each installed tool's `envAlias` (resolved against the daemon env) and render any `configFile` templates into the thread env/HOME.

### Web (read-only) (`routes/tools.ts`, web Settings)
- `GET /api/tools` → `toolStatuses()`.
- A read-only **Tools** section in Settings (sibling to Integrations): each tool with installed/authed badges + description + docs link. No add/remove in the UI (v1).

## Data flow
`dispatch build`/`update` → `tools install` (download/verify/place into `~/.dispatch/tools/bin`). Thread spawn → `pty/manager` prepends `bin/` to PATH + merges `envAlias`/`configFile` → agent sees the tools and the awareness note (Claude: `--append-system-prompt`; Codex: `-c developer_instructions`) → agent shells out to a tool, authed via Doppler env.

## Error handling
- Install: checksum mismatch / download failure / extract failure → that tool fails (logged), others continue; `dispatch build` doesn't abort.
- Manifest: invalid entries dropped with a warning.
- Awareness: generation/injection is best-effort; a failure to build or attach the note is logged and never blocks spawn (the tools stay on PATH regardless).
- Idempotency: re-running install is a no-op for unchanged tools.

## Security considerations
With `--dangerously-skip-permissions` (Claude) / bypass-approvals (Codex), the agent can invoke **any** bundled CLI freely. Bundling authed `doppler`/`aws`/`gh`/`databricks` therefore grants the agent authenticated access to all of them — notably `doppler`, which can read every secret in the configured Doppler project. This is an accepted tradeoff for a single-user self-hosted tool; scope the tokens in Doppler as tightly as the workflows allow. The awareness note and Settings view make the granted capability visible.

## Testing
- **manifest:** default+user merge/override, validation, optional-checksum handling.
- **installer:** `binary` with a faked `download` returning a fixture archive — sha256 verify (match + mismatch), extraction, placement, chmod, idempotency; `npm` (mock the install step) → symlink; `script` (a trivial script writing a bin into `$TOOLS_BIN`).
- **status/awareness:** installed/authed detection from a temp prefix + env; note text (authed vs unauthed; empty when none).
- **spawn/injection:** the env-assembly helper prepends `bin/` to PATH and merges `envAlias`; the awareness note is folded into Claude's system-prompt args and TOML-encoded into Codex's `-c developer_instructions=` arg (and the Codex flag is omitted when the note is empty); a unit test covers the TOML string encoding (quotes/backslashes/newlines).
- **routes:** `GET /api/tools` shape.
- **web:** the Tools view renders the list with installed/authed badges (RTL).

## Out of scope (follow-ups)
Linux/Windows binaries; editing tools from the UI; interactive-login CLIs (e.g. `gcloud auth login`); per-project tool subsets; auto-update/version pinning UX beyond `dispatch update`.

## Decision
Add a self-contained `packages/core/src/tools/` subsystem (manifest + installer + status/awareness + CLI), a one-line PATH prepend in the spawn path, provider-specific awareness injection (Claude `--append-system-prompt` / Codex `-c developer_instructions`), and a read-only Settings view. No change to the MCP integration layer; this sits beside it as the CLI vector.
