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
      `wsl.exe -d Ubuntu --exec <repo>/bin/dispatch daemon-run`.
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

## Sign-off

- [ ] All boxes above checked, or gaps explicitly written down as known issues.
- [ ] File/update `docs/wsl2-bring-up.md` itself if any step's instructions turned out
      to be wrong or incomplete on real hardware — this doc should stay accurate for
      the next milestone's pass.
