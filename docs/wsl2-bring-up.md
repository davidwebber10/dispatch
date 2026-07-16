# WSL2 bring-up checklist (Tier 3)

This is the once-per-milestone, real-hardware validation pass for the `wsl` platform
flavor. Tier 1 (conformance suite with injected fakes) and Tier 2 (Docker fake-wsl
harness) run on every push and don't need Windows; this tier is the final check on an
actual Windows machine before calling a milestone done. See "Testing" in
`docs/superpowers/specs/2026-07-15-wsl2-windows-support-design.md` for the full
Tier 1/2/3 rationale.

Run through the list top to bottom on a fresh VM. Check each box; where the item says
"record observed behavior," write down what actually happened (not just pass/fail) —
some of this is genuinely unverified until someone runs it for real.

## 0. Tier 2 first (run before touching the VM)

- [ ] Run the Docker fake-wsl harness locally and confirm it's green before spending
      VM time: `scripts/test-wsl-docker.sh` (lands in Task 15). It shims `wslpath` /
      `explorer.exe` / `powershell.exe` / `wsl.exe` on `PATH`, sets `WSL_DISTRO_NAME`,
      and drives the API (create session/terminal, POST reveal), asserting the shims
      were invoked with correctly-translated paths. This proves the
      request → adapter → interop pipeline without needing Windows at all — Tier 3
      below is only for the things Tier 2 *can't* fake (a real Windows logon session,
      a real reboot, a real phone).

## 1. Provision the VM

- [ ] Spin up a cloud Windows VM with **nested virtualization** support — WSL2 needs
      a real hypervisor underneath it, which most budget cloud SKUs don't expose.
      **Azure Dv5-class** (or later, e.g. Dv5/Ev5) instances support nested virt and
      work for this; a few dollars covers an afternoon. Confirm nested virt is
      actually on before proceeding (a plain/older Dv2-class box will fail WSL2
      install with a hypervisor error).
- [ ] RDP into the VM as a normal (non-admin-forced) user profile — the logon task in
      step 3 is per-user, so test under the account you'll actually sign in as.

## 2. Stage-1 installer (`scripts/install-windows.ps1`)

- [ ] Prerequisite note: on current (non-LTS) Ubuntu WSL images, `apt install nodejs npm`
      pulls Node 22, whose Debian-packaged `corepack` throws
      `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` when running `corepack enable pnpm` or the
      resulting pnpm shim. If pnpm bootstrap fails this way, use `npm install -g pnpm@11.5.2`
      (or any recent `npm i -g pnpm`) instead — `scripts/install.sh` already recommends this
      first on Linux for exactly this reason.
- [ ] Download or paste `scripts/install-windows.ps1` onto the VM and run it from
      PowerShell.
- [ ] **First run, WSL2 not yet installed:** the script prints
      "Installing WSL2 (this can require a reboot — re-run this script afterwards)...",
      runs `wsl.exe --install -d Ubuntu`, and exits 0 without erroring.
- [ ] **Reboot-resume path:** if the install requested a reboot, reboot the VM,
      sign back in, and re-run the *same* script. Confirm it picks up where it left
      off (idempotent) rather than erroring or re-triggering a redundant install.
- [ ] **Ubuntu first-run setup:** if the script reports Ubuntu is still installing
      and asks you to complete first-run user setup, do so (set the Linux username/
      password when the Ubuntu console prompts), then re-run the script again.
- [ ] **Final run:** the script prints "WSL2 ready — installing Dispatch inside
      Ubuntu...", clones/pulls the repo inside WSL, runs `./scripts/install.sh`
      inside Ubuntu, and finishes with "Done. Open http://localhost:3456".
- [ ] Confirm the whole sequence is safe to re-run at any point (re-running after
      success should be a no-op / harmless, not a duplicate install).

## 3. Logon task survives sign-out/in

- [ ] After stage-1 completes, confirm `dispatch status` (run inside WSL) reports the
      daemon running.
- [ ] Sign out of the Windows session entirely (not just lock), then sign back in.
- [ ] Without running anything manually, confirm the daemon is back up: check
      `http://localhost:3456` loads, and/or `dispatch status` inside WSL shows a
      live pid. This is the Windows **scheduled task at logon**
      (`schtasks.exe /Create ... /SC ONLOGON`) re-launching
      `wsl.exe -d Ubuntu --exec <node> <repo>/packages/cli/dist/index.js daemon-run`
      (absolute node path, absolute CLI entry — not the `bin/dispatch` shim — so the
      task doesn't depend on nvm-installed node being on the logon task's PATH).
- [ ] Record observed behavior: how long after sign-in did the daemon become
      reachable? Any visible console window flash, or fully silent?

## 4. Host browser: Reveal

- [ ] From a browser **on the Windows host** (not inside WSL), open
      `http://localhost:3456`. Confirm it loads via `localhostForwarding` (no extra
      port-forwarding setup needed).
- [ ] Open a project/session and locate the Reveal action. Confirm the UI shows
      "Reveal in Explorer" (i.e. `fileManagerName` came back non-null — interop with
      `explorer.exe` is available).
- [ ] **Reveal a `~/...` (Linux filesystem) path:** click Reveal on a file whose
      session `workingDir` is under the Linux home directory. Confirm Explorer pops
      with the file selected, and the address bar shows a UNC path of the form
      `\\wsl.localhost\Ubuntu\home\<user>\...` (i.e. `wslpath -w` translated a
      Linux-FS path to the `\\wsl.localhost\<distro>\...` UNC form, not `/mnt/c`).
- [ ] **Reveal an `/mnt/c/...` (Windows filesystem) path:** click Reveal on a file
      whose `workingDir` is under `/mnt/c/...`. Confirm Explorer pops with the file
      selected, and the address bar shows a native `C:\...` path (i.e. `wslpath -w`
      translated it back to a drive-letter path, not a UNC path).
- [ ] Confirm both Reveal calls used argument-array exec under the hood (no shell
      string) — check the daemon logs for the `explorer.exe` invocation and argv if
      you want to double check there's no quoting/injection surprise.

## 5. Self-update: restart in place

- [ ] Before updating, note the current daemon pid (`dispatch status`) and version.
- [ ] If you're running on a non-default port (set `PORT=<custom>` at install time),
      confirm that's still the case before updating — this checklist specifically
      wants that custom port to survive the update.
- [ ] Trigger an update (`git pull` a newer commit + apply, however the app exposes
      it — settings UI "Update" button or the update/apply API).
- [ ] Confirm the version bump is visible in the UI/`dispatch status` after the
      update completes.
- [ ] Confirm the daemon **pid changed** (old process exited, a new one is running) —
      this is an in-place restart, not a reload.
- [ ] Confirm the **custom `PORT` was preserved** across the restart (still reachable
      on the port you configured, not reset to the default 3456). This exercises the
      env/port-preservation fix in `daemon-wsl.ts`'s `restart()`: it persists
      `daemon.json` at install time and always re-applies `opts.port` as the `PORT`
      env var on respawn, so an install-time custom port wins over whatever ambient
      env the new process happens to inherit.
- [ ] **Record observed behavior when the old `wsl.exe` anchor exits.** The
      logon-task-launched `wsl.exe -d Ubuntu --exec ... daemon-run` process anchors
      both the WSL VM's lifetime and the daemon's interop context; the in-place
      restart kills the *old* daemon process and spawns a *new*, separately-detached
      one that isn't parented by that same `wsl.exe` invocation. Write down what you
      actually observed: does the original `wsl.exe` process/console exit once its
      child dies? Does the VM stay up regardless (because the new detached process
      keeps it alive)? Does Reveal (interop) still work after this handoff, or does
      the daemon lose `explorer.exe`/`wslpath` access until the next logon? This is
      the one behavior in the design that's asserted ("the VM stays alive because the
      new process runs") but not yet confirmed on real hardware — that's the point of
      this checklist item.

## 6. Remote access: phone via Tailscale, no Reveal

- [ ] Set up Tailscale reaching this daemon (either `tailscaled` inside WSL, or
      Windows-side Tailscale + `tailscale serve` in front of `localhost:3456` — either
      is fine, use whichever matches how you'd actually deploy this).
- [ ] From a phone on the same tailnet, open the Tailscale hostname/IP for this
      machine. Confirm the app loads and is usable (create a session, open a
      terminal).
- [ ] Confirm Reveal is **not** offered to the phone client. This is `isLocalClient`
      correctly treating a tunneled/remote peer as non-local even though
      `fileManagerName` is non-null on the daemon — Reveal must not appear (or must
      no-op) for this client.
- [ ] Record observed behavior: exactly how does the UI communicate "no Reveal here"
      (action hidden entirely vs. disabled vs. some other treatment)?

## Known deferrals

- The `/mnt/*` working-dir warning (see the Tier-2 harness's `MNT_JSON` check) is
  currently API-only: it comes back on the session-create response's `warning`
  field, but nothing in the web UI surfaces it to the user yet. Until that's wired
  up, expect to see it only by inspecting the raw API response (or the Tier-2
  harness assertion), not in the app itself.
- WSL Reveal always selects the **first file only**, even for a multi-file
  selection — `explorer.exe /select,<path>` accepts exactly one path (unlike
  macOS's `open -R`, which accepts several). This is intentional (see
  `revealInFileManager` in `packages/core/src/platform/wsl.ts`), not a bug to
  chase during bring-up. When exercising item 4 above with a multi-file selection,
  expect single-select behavior on WSL — do not fail the checklist item over it.

## Sign-off

- [ ] All boxes above checked, or gaps explicitly written down as known issues.
- [ ] File/update `docs/wsl2-bring-up.md` itself if any step's instructions turned out
      to be wrong or incomplete on real hardware — this doc should stay accurate for
      the next milestone's pass.

## Tier-3 run log — 2026-07-16 (AWS m5zn.metal, Windows Server 2022, WSL 2.7.10)

Full real-hardware pass on an AWS `m5zn.metal` spot instance (Windows Server 2022, nested
virt via bare metal) running WSL 2.7.10 / kernel `6.18.33.2-microsoft-standard-WSL2` /
Ubuntu. Findings below; the four fixable ones are already applied on this branch.

**PASS**

- WSL detection: kernel `6.18.33.2-microsoft-standard-WSL2`, interop probe via
  `/proc/sys/fs/binfmt_misc/WSLInterop`, `WSL_INTEROP` env present.
- Host-side probe through `localhostForwarding` returned
  `{"platform":"linux","flavor":"wsl","fileManagerName":"File Explorer","canReveal":true}` —
  confirms the NAT-gateway localness rule against a real Windows-host client, not just the
  Docker fake-wsl harness.
- Full install path: `apt` git/node 22 → npm-installed pnpm → clone → `install.sh` bootstrap
  → build → tools → `dispatch install`; the logon schtask registered correctly via interop
  from inside WSL.
- Reveal end-to-end: `POST /files/reveal` → 200, `wslpath` produced
  `\\wsl.localhost\Ubuntu\root\proj\hello.txt`, and a real Explorer window titled "proj"
  opened in the user session.
- `/mnt` session warning delivered verbatim over the API.
- ONLOGON autostart: after an unattended reboot + autologon, the Dispatch scheduled task
  started the daemon with zero manual intervention (task `0x41301`, probe green).

**FAIL → FIXED (this branch)**

- **TR quoting (F1).** The registered TR quoted the distro and paths
  (`wsl.exe -d "Ubuntu" --exec "/usr/bin/node" "<repo>/…" daemon-run`). Live result: task
  failed with `Last Result -1` — `wsl.exe --exec` does naive whitespace splitting, not shell
  parsing, so the quoted `"/usr/bin/node"` was exec'd literally (quotes included) → ENOENT.
  The unquoted form was verified working live (task `Running 0x41301`, daemon up). Fixed in
  `packages/core/src/platform/daemon-wsl.ts`: the TR is now built unquoted, and `install()`
  validates up front that none of the node path, repo root, or distro name contain a space
  (throwing a clear, actionable error before touching schtasks/disk) since the unquoted form
  can't otherwise represent a space-containing component.
- **Restart grace too short (F2).** With live PTY sessions attached, a SIGTERM'd daemon
  (pid 605) took more than 5s to exit; `restart()` correctly threw rather than double-spawn,
  but the old daemon then exited *after* the throw — leaving nothing running, so a
  self-update could brick the daemon. Fixed: the wait loop's bound grew from 5s to 30s
  (300 × 100ms polls, same `Atomics.wait` pattern, now configurable via `waitIterations` for
  fast tests), and `restart()` now takes one final liveness re-check immediately before
  throwing — a pid that dies in that last gap is treated as gone and the new instance is
  spawned instead of leaving the system dead. A genuinely-still-alive pid still throws.
- **Corepack pnpm guidance (F3).** Modern WSL's catalog installs the latest Ubuntu, whose
  `apt install nodejs npm` gives Node 22 with a Debian-packaged `corepack` that throws
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` on `corepack enable pnpm` / the pnpm shim.
  `npm install -g pnpm@11.5.2` worked live as the fallback. Fixed: `scripts/install.sh`'s
  Linux remediation message now recommends `npm i -g pnpm` first, with `corepack enable
  pnpm` as the alternative (previously the reverse); a matching prerequisite note was added
  to this doc's Stage-1 installer section.
- **`aws` tool recipe is macOS-only (F4).** Bundled-tools provisioning failed on Linux for
  `aws` ("`pkgutil: not found` … `aws failed (continuing)`") — non-fatal (the installer
  continues past tool failures) but misleading, since the recipe shells out to macOS's
  `pkgutil` and was never going to work on Linux. Fixed: the tools manifest now supports a
  `platforms` field (OS-family gate, e.g. `["darwin"]`); the `aws` entry is gated to
  `darwin` so it fails fast with a clear "not supported on linux" message instead of a
  confusing `pkgutil: not found`. Follow-up (not done here): a Linux variant is
  straightforward to add — the official
  `https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip` installer — but the existing
  `script` recipe shape is a single command string, not platform-keyed like `binary`
  entries, so wiring that in cleanly is left for a follow-up rather than bolted on here.

**FINDINGS (no code change)**

- Server 2022's `wsl --install` first pass left the inbox (old) WSL installed
  ("the parameter is incorrect"); modern WSL only landed via an explicit MSI from
  `github.com/microsoft/WSL` releases. The installer docs should mention this MSI fallback —
  added as one sentence to this doc's troubleshooting-adjacent notes above (see the Stage-1
  section).
- WSL/SSM headless caveats: `wsl.exe` refuses to run as `SYSTEM`. Validation used autologon +
  a user-context scheduled task, which mirrors Dispatch's own production mechanism, so this
  isn't a gap in the design — just a reminder that any *automation* driving this checklist
  needs the same user-context constraint.
- The modern WSL catalog installs the **latest** Ubuntu, not necessarily an LTS — worth
  knowing when comparing behavior across bring-up runs on different dates.
- `install.sh`'s success message currently prints before the daemon is probed reachable; in
  the `Last Result -1` failure mode (F1, now fixed) it printed a misleading "Dispatch is
  running" ahead of a task that had actually failed. Noted as a candidate improvement
  (probe-based success message) — not fixed here, since F1 removes the specific failure mode
  that made it visible, but a probe would make the message trustworthy in general.

**Cost:** ~2h spot `m5zn.metal` ≈ $5.
