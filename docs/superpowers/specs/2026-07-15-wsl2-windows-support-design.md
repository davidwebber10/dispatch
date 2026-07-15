# Dispatch — Windows Support via WSL2 (the `wsl` Platform Flavor)

**Date:** 2026-07-15
**Status:** Design approved in discussion; spec awaiting review.
**Target:** Windows 10/11 with WSL2. Dispatch's daemon runs *inside* WSL2 as a Linux
process; a thin interop layer makes the Windows host a first-class citizen.

## Goal

Make WSL2 **the** Windows story for Dispatch: someone on Windows installs it with one
guided path, the daemon and all agents (Claude Code, Codex) run inside WSL2, and every
host-facing feature the Mac has — Reveal in Finder, tunnel detection, autostart,
self-update — works against the Windows host through an OS abstraction that *forces*
platform parity: adding a capability for one OS breaks the build until every OS answers.

## Decisions (confirmed)

1. **Product:** WSL2-only Windows support. The native-win32 port
   (`worktree-windows-native-impl`) is **parked**: its platform-abstraction, `linux`,
   and CLI work merges; its win32-specific parts stay on the branch, unshipped.
2. **Audience:** other people install it — the install path must be genuinely smooth.
3. **Scope:** full parity with macOS: install + autostart, self-update from the UI,
   Reveal in File Explorer, tunnel detection, translated UI text and shortcut hints.
4. **Architecture:** extend the existing `packages/core/src/platform/` contract (from
   the native branch) with the deferred host-integration methods; add `wsl` as a fourth
   platform selection implemented as `linux` plus a small interop delta.
5. **Verification:** no local WSL2 hardware. Tiered testing: conformance/unit tests with
   fakes → Docker Ubuntu with interop shims → one real-WSL2 validation pass on a cloud
   Windows VM with nested virtualization (e.g. Azure Dv5).
6. **Branch:** all work on a dedicated branch (`worktree-wsl2-flavor`), independent of
   the shared checkout.

## Non-goals

- Shipping or documenting native-Windows (non-WSL) support. The interface keeps the
  parked `win32.ts` compiling, but no install path, docs, or CI target it.
- Windows-native niceties that need a host-side agent (toast notifications, tray icon).
  The interop layer leaves room; nothing in v1 requires a Windows-side process beyond
  one scheduled task.
- Changing macOS behavior. `darwin.ts` wraps existing code paths exactly.

## Phase 0 — land the base from the native branch

Today's `main` has no Linux support at all (`install.sh` hard-fails off-Darwin,
`bin/dispatch` is launchd-only bash, `/bin/zsh` hardcoded, no Linux tool rows). The
native branch already built what WSL needs. Extract onto `main` (selective apply, not a
full merge — the branch carries a dozen merge-backs):

- `packages/core/src/platform/` — `types.ts`, `index.ts`, `darwin.ts`, `linux.ts`,
  `daemon.ts`, `daemon-darwin.ts`, `encode.ts` + their tests. (`win32*.ts` stays parked.)
- `packages/cli/` — the cross-platform Node CLI replacing `bin/dispatch`'s bash guts.
- The de-mac-ification sweep of core (`server.ts`, `sessions/service.ts`,
  `providers/claude-code.ts`, `routes/state.ts`, `setup/detect.ts`) and portable fixes
  (path normalization, transcript-dir encoding).

**Coordination:** another session actively works that branch (last push 2026-07-13,
Windows CI polish). The WSL2-only decision must reach it before it invests further in
`windows-latest` runners. This spec records the decision; a human has to deliver it.

## Architecture

### Platform selection

`selectPlatform()` gains WSL detection: `process.platform === 'linux'` and
(`WSL_DISTRO_NAME` set, or `/proc/version` contains `microsoft`, checked in that order —
the env var is absent in some daemon contexts, the file read is authoritative) → `wsl`.
The reader is injectable for tests. `wsl.ts` is `{ ...linux }` plus overrides, so the
file reads as exactly the delta between WSL and plain Linux.

### New `Platform` capabilities (the parity ratchet)

Added to the interface, so every implementation must answer or the build fails:

| Method | darwin | wsl | linux | win32 (parked) |
|---|---|---|---|---|
| `fileManagerName` | `"Finder"` | `"File Explorer"` | `null` (headless) | `"File Explorer"` |
| `revealInFileManager(paths)` | `open -R` | `explorer.exe /select,` + `wslpath -w` per path | unsupported | `explorer.exe /select,` |
| `isLocalClient(client)` | loopback peer + loopback Host + unproxied | **loopback-or-gateway** peer + loopback Host + unproxied | loopback rule | loopback rule |
| `detectTunnels()` | `Tailscale.app` binary | in-WSL `tailscale`, else `tailscale.exe` via interop | in-PATH `tailscale` | `tailscale.exe` |
| `toolPlatformKey()` | `darwin-{arm64,x64}` | `linux-{x64,arm64}` | `linux-{x64,arm64}` | `win32-x64` |

`files/reveal.ts`'s pure helpers (`isLoopbackAddress`, `isLoopbackHost`, proxy-header
checks) survive as shared building blocks; the darwin-only `canReveal` moves behind
`platform.isLocalClient` + `fileManagerName !== null`.

### `isLocalClient` on WSL — the one subtle rule

With default NAT networking, a browser on the Windows host reaches the daemon through
WSL's localhost relay and arrives from the **WSL gateway IP** (the Windows vEthernet
address), not loopback. Darwin's rule would hide Reveal from the exact user it serves.
The wsl rule: peer is loopback **or** the default-gateway address (read once at boot
from `ip route show default`, cached), *and* the Host header is a loopback name, *and*
no proxy headers. This still fails closed for everything that isn't the host browser:

- LAN machine via `netsh portproxy`: arrives from the gateway too, but carries
  `Host: 192.168.x.x` — refused by the Host check.
- Tunnel (Tailscale serve / cloudflared): proxy headers present — refused.
- Mirrored networking mode (newer WSL): host browsers arrive as genuine `127.0.0.1`
  and pass the same rule with no special casing.

### Reveal path translation

`wslpath -w` translates each absolute Linux path before `explorer.exe /select,`:
`/mnt/c/...` becomes `C:\...`; Linux-FS paths become `\\wsl.localhost\<distro>\...`
UNC paths, which Explorer opens and multi-selects normally. Argument-array exec, never
a shell string (same injection discipline as `revealInFinder` today). Interop
availability is probed once at boot (can we resolve `explorer.exe`?); if absent
(daemon started outside an interop context), `fileManagerName` reports `null` and the
UI simply never offers Reveal — degraded, not broken.

## Install & lifecycle

Two stages; stage 2 configures the Windows side *from inside WSL* via interop, so there
is no separate Windows installer to maintain.

**Stage 1 — Windows bootstrap (`scripts/install-windows.ps1`, one PowerShell command):**
idempotent and resumable: checks for WSL2 (`wsl --status`), runs
`wsl --install -d Ubuntu` if missing (may require one reboot; the script says so and
picks up where it left off), then executes stage 2 inside the distro.

**Stage 2 — inside WSL (the existing Linux install path):** clone, `pnpm install`,
build, then `dispatch install` (packages/cli), which on the `wsl` platform:

- Registers a **Windows scheduled task at logon** via `powershell.exe` interop:
  `wsl.exe -d <distro> --exec <repo>/bin/dispatch daemon-run`. The `wsl.exe` process
  anchors the distro VM's lifetime and provides the daemon an interop context (so
  `explorer.exe`/`wslpath` work). This mirrors the per-user LaunchAgent semantics.
- Does **not** require systemd: no `wsl.conf` edits, no `wsl --shutdown` friction.
  systemd-enabled distros work unchanged; we just don't depend on it.

**Networking:** `localhostForwarding` (default on) makes `http://localhost:3456` work
from the Windows browser. Remote access (phone, other machines) is documented through
Tailscale — either in-WSL `tailscaled` or Windows-side Tailscale + `tailscale serve` —
matching how the mac mini is used today. No `netsh portproxy` in the docs; it's
fragile (WSL's IP changes) and `isLocalClient` treats it as remote by design.

**Filesystem guidance:** projects belong in the Linux filesystem (`~/...`), not
`/mnt/c` (slow 9p I/O, case-insensitive). Session creation warns when a `workingDir`
starts with `/mnt/`.

## Self-update

`update/apply.ts` keeps spawning the detached CLI updater. On `wsl`/`linux` the
updater: `git pull` → build → **in-place restart** (spawn the new server detached,
old process exits). No launchctl/systemctl dependency; the VM stays alive because the
new process runs. The `DaemonController` for wsl implements install/uninstall (the
scheduled task, via interop) and restart (in-place). Verifying that a detached
restart survives the `wsl.exe` anchor process is an explicit Tier-3 checklist item.

## UI translation

- **Server-driven facts:** `GET /api/state/host` (exists) adds `flavor`
  (`macos | wsl | linux`) and `fileManagerName`. The client renders
  `Reveal in {fileManagerName}` and hides the action when `null` — zero
  platform-conditional strings in the web bundle.
- **Client-driven input conventions:** keyboard hints and accelerators follow the
  *browser's* OS, not the daemon's (a Mac user browsing a WSL daemon still sees ⌘).
  One helper (`isMacLike(navigator)`) drives hint text (⌘N ↔ Ctrl+N in
  EmptyWorkspace, panes) and shortcut handlers accept `metaKey` on mac-like /
  `ctrlKey` elsewhere where they currently assume meta.

## Tool downloads

`default-tools.json` gains `linux-x64` and `linux-arm64` rows (jq, ripgrep, gh,
doppler, databricks — all publish Linux builds) with pinned sha256s.
`toolPlatformKey()` provides the lookup key per platform.

## Testing (no local WSL2 hardware)

- **Tier 1 — every push, runs anywhere:** the conformance suite runs the *same*
  contract cases over darwin/linux/wsl with injected exec/filesystem fakes
  (`describe.each`), and iterates the interface keys so an unimplemented or untested
  method fails loudly. WSL specifics unit-tested with fakes: detection matrix
  (env/`/proc/version`), `wslpath` output mapping, `isLocalClient` matrix (NAT
  gateway / mirrored loopback / portproxy LAN / proxied tunnel).
- **Tier 2 — local integration, Docker Ubuntu:** run the daemon in a container as
  `linux`, and as **fake-wsl**: shim `wslpath` / `explorer.exe` / `powershell.exe` /
  `wsl.exe` scripts on PATH that log their argv to a file, `WSL_DISTRO_NAME` set.
  Drive the API (existing verify-skill recipe: create session/terminal, POST reveal)
  and assert the shims were invoked with translated paths. This proves the full
  request→adapter→interop pipeline without Windows.
- **Tier 3 — once per milestone, real WSL2:** cloud Windows VM with nested
  virtualization (Azure Dv5-class, a few dollars for an afternoon). Scripted
  checklist in `docs/wsl2-bring-up.md`: stage-1 installer (including the reboot
  path), logon task boots the daemon, host browser gets Reveal (Explorer pops with
  multi-select, both `/mnt/c` and `\\wsl.localhost` paths), update/apply restarts
  in place, phone reaches it via Tailscale, `isLocalClient` refuses the tunnel.
- **CI:** add an `ubuntu-latest` leg running the core suite plus Tier-1 WSL tests —
  the anti-afterthought gate: Linux/WSL breakage surfaces on the same commit.

## Error handling

- `wslpath` or `explorer.exe` failing at request time → 500 with the exec error;
  the button stays (transient failure), logs carry argv.
- Interop absent at boot → `fileManagerName: null`, Reveal never offered; a setup
  note explains the daemon must start via the logon task (or any interop context).
- Scheduled-task registration failure (PowerShell policy) → `dispatch install`
  prints the exact PowerShell to run manually; daemon still runs foreground.
- `/mnt/*` working directories → warning, not refusal.

## Milestones

1. **Phase 0:** extract platform/CLI/linux base from the native branch onto `main`.
2. **Flavor:** `wsl.ts` + selection + new interface methods across all platforms +
   conformance suite + tool rows.
3. **Host UX:** reveal pipeline, `state/host` facts, client text/hint translation.
4. **Lifecycle:** stage-1/2 installers, scheduled task, self-update restart.
5. **Validation:** Docker Tier-2 suite in CI; Tier-3 cloud-VM pass; bring-up doc.
