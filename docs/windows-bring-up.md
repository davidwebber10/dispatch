# Windows runtime bring-up checklist

This checklist covers the **runtime-only confirmations** that CI cannot perform — things
that require a real Windows 11 machine, a logged-in user session, and the actual installed
agent CLIs. Automated unit tests and the `windows-latest` GitHub Actions workflow cover
build correctness and logic; this checklist covers end-to-end behaviour.

**One thing to confirm and potentially adjust:** step 3 asks you to verify the
`claudeProjectDir` encoding. The `win32` implementation encodes the working-directory path
into `%USERPROFILE%\.claude\projects\<encoded>` — the encoding must match what Windows
Claude Code actually uses byte-for-byte. This is isolated to a single method so a fix, if
needed, is local and does not require broader changes.

Work through all seven steps in order. Record any discrepancies against the expected
behaviour described below and report them before closing out the bring-up.

---

## Step 1 — Install and confirm the daemon serves

```powershell
dispatch install
dispatch status
```

**Expected:** `dispatch install` registers a Task Scheduler at-logon task for your user
account and starts the daemon. `dispatch status` reports the daemon running and HTTP
reachable at `http://localhost:3456`. Open `http://localhost:3456` in a browser and confirm
the Dispatch web client loads.

---

## Step 2 — Shell terminal spawns via ConPTY

In the Dispatch web client, create a new **shell** terminal (plain shell, not an agent).

**Expected:** a real PTY session spawns and streams — you can type commands and see output.
This exercises the ConPTY path via `node-pty 1.1.0`. Confirm bidirectional I/O works
(input echoes, commands execute, output streams without corruption).

---

## Step 3 — Claude Code terminal + transcript-dir encoding

Create a **Claude Code** terminal pointed at a project directory.

**Expected:** Claude Code spawns. Then check the transcript directory:

1. Note the project working directory path (e.g. `C:\Users\you\projects\myapp`).
2. Confirm that `%USERPROFILE%\.claude\projects\` contains a subdirectory whose name is the
   encoded form of that path as Windows Claude Code expects it.
3. Compare that directory name against what `claudeProjectDir()` in the `win32` platform
   implementation produces for the same path.

If they match: encoding is correct, no action needed.
If they differ: record the expected vs. actual encoding and report it — the fix is a
one-line change in `packages/core/src/platform/win32.ts`.

---

## Step 4 — Codex terminal + notify hook

Create a **Codex** terminal.

**Expected:** Codex spawns natively on Windows (no WSL). Confirm:
- The Codex process starts and is interactive.
- The Dispatch notify hook fires: after the agent completes a task, the thread status in
  the Dispatch UI updates (e.g. shows a completion indicator). This confirms the
  `codex-notify.mjs` hook path is constructed correctly with `path.join` for Windows
  separators and invoked via the resolved `node` binary.

---

## Step 5 — Headless agent run (both providers)

Run a headless agent task for **both** Claude Code and Codex via the Dispatch Agents UI.

**Expected:** each agent run completes, and the transcript/replay is accessible in the
Dispatch UI afterward. This confirms the full headless-agent code path works end-to-end on
Windows.

---

## Step 6 — Restart and update survive

```powershell
dispatch restart
dispatch status
```

Then (if a newer commit is available, or simulate with a no-op pull):

```powershell
dispatch update
dispatch status
```

**Expected:** `dispatch restart` stops and restarts the daemon; the Task Scheduler task
survives the restart cycle and the daemon comes back on `http://localhost:3456`. `dispatch
update` (git pull + rebuild + restart) completes without error and the daemon is reachable
afterward.

---

## Step 7a — Inbox upload path separators

Upload a file via the Files UI (drag-drop or the upload button) into any session.

**Expected:** the response JSON and the displayed path in the UI both use forward slashes
(`/`) as separators — e.g. `.dispatch/inbox/1234567890-abc-myfile.txt`. If backslashes
(`\`) appear in the path returned from `POST /api/sessions/:id/files/inbox`, the
normalization in `packages/core/src/routes/files.ts` is not working correctly — report it.

---

## Step 7b — Claude transcript directory encoding

After a Claude Code terminal has run at least one exchange:

1. Open PowerShell and run:
   ```powershell
   dir "$env:USERPROFILE\.claude\projects"
   ```
2. Note the subdirectory name for your project path (e.g. for `C:\Users\you\proj` it might
   be `-C--Users-you-proj` or similar).
3. Compare it against what `platform.claudeProjectDir('C:\\Users\\you\\proj')` produces in
   Node (run: `node -e "const {platform}=require('./packages/core/dist/platform/index.js'); console.log(platform.claudeProjectDir('C:\\\\Users\\\\you\\\\proj'))"`).

If they match: transcript loading in the View pane works. If they differ, record the
expected vs. actual encoding and update `packages/core/src/platform/encode.ts` accordingly
(one-line change in the `win32` branch).

---

## Step 8 — Deferred features degrade gracefully

**Expected (no crash, no unhandled error):**

- Open the Tailscale-status panel in the Dispatch UI. It should show "unavailable" — not a
  crash or a JavaScript error in the console.
- Trigger an OAuth flow from within an agent session (e.g. a provider that requires
  browser-based login). The system browser should open and the OAuth flow should proceed
  there. The Dispatch in-app relay is not wired on Windows v1 — this is expected and
  documented, not a bug.

If either feature throws an unhandled error instead of degrading gracefully, report it.
