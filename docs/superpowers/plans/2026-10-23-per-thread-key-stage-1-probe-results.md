# Per-thread keys, stage 1: delivery probe results

Date: 2026-10-23. Probe: `scripts/key-delivery-probe.mjs` (fixtures in `scripts/probe-fixtures/`).
Plan: `2026-10-23-per-thread-key-stage-1.md`, Task 1. Spec: section 6.3.

## Versions

| CLI | Version |
|---|---|
| `claude` | 2.1.309 (Claude Code) |
| `codex` | codex-cli 0.164.0 |
| `grok` | grok 1.0.67 [alpha] |
| `opencode` | v2.1.3 (a v2.1.2 background service of the owner was already running) |

## Method

- Clean env: `env -i` with only `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG` and `PATH`. The probe refuses to start when any `DISPATCH_*` variable is set.
- A fake daemon on a free port (never 3456) records the `Authorization` header of every request and maps it back to a canary label. A label such as `A#2` means thread `A`, second key minted for it.
- Each canary exists in memory only. It travels in env, in a thread config over a pipe, or (opencode literal row, not run) in one `0600` file. It never goes into argv. The probe never prints a canary.
- Each CLI used the real config home, read only. No sign-in file was copied, moved or deleted.
- Effective-config audit before any model call (real HOME, clean env): `codex mcp list` shows only bundled tools and no Dispatch URL. `~/.claude/settings.json` holds one `PreToolUse` command hook (`rtk hook claude`) and no HTTP hook. `claude mcp list` shows only hosted connectors. The Grok config holds no hook or MCP server. The opencode config folder holds no `opencode.json`. No MCP server, hook or notify target points at a Dispatch daemon.
- Models: `haiku` (Claude), `gpt-5.6-luna` (Codex), the default `grok-4.7` (Grok, the only listed model), `openrouter/~google/gemini-flash-latest` (opencode).
- Scan: after each run the probe read every file modified after the start under `~/.codex`, `~/.claude`, `~/.grok`, the opencode data, config, state and cache folders, `~/Library/Logs` and the scratch folder, and looked for the canaries as bytes. It also fed the app-server stdout and stderr, every JSON-RPC response and notification, the manager event ring, and each captured process output through the same check.
- Codex Pretty used `approvalPolicy: 'never'` and `sandbox: 'danger-full-access'` so a sandbox network rule could not confuse the shell row. The thread config held `mcp_servers.dispatch` with a literal `env.DISPATCH_AUTH` and `shell_environment_policy.set.DISPATCH_AUTH`; the app-server env was `{}`. Five threads shared one app-server (an idle anchor Z, then A, B, C, D).

## Results

| Row | Observed | Gate outcome | Delivery for Tasks 12 to 14 |
|---|---|---|---|
| Codex Pretty, MCP and shell, two or more threads at once | Every MCP request and every shell request carried the thread's own canary. No swap, no share, across A, B, C and D. | (delivery works) | |
| Codex, canary in a file | Pretty: no canary in any file, rollout, log, sqlite file, event, JSON-RPC response or app-server stream. CLI view (PTY): the canary is in `~/.codex/shell_snapshots/*.sh` as an `export DISPATCH_AUTH=...` line (file mode 0644, one new snapshot file per CLI start). See Finding 1. | Pretty: canary in no file and no event. CLI view: canary in a file | Pretty: spec table (literal in thread config). CLI view: key file (`DISPATCH_AUTH_FILE` in the PTY env, file `DATA/keys/ID` mode `0600`) |
| Codex resume, idle thread, 3 s after kill | New canary arrived (MCP and shell). | new | |
| Codex resume, idle thread, 16 s after kill | New canary arrived (MCP and shell). | new | |
| Codex resume, killed during a running turn, 12 s after kill | OLD canary arrived (MCP and shell). The new key was never used. | old | the Codex Pretty sticky key of Task 12 |
| Codex resume, killed during a running turn, 16 s after kill | OLD canary arrived (MCP and shell). | old | the Codex Pretty sticky key of Task 12 |
| Codex Pretty, app-server SIGKILL, then call again in two threads | Each thread's MCP and shell carried the thread's current canary (the one in its stored `threadConfig`). | (crash recovery keeps the same key) | nothing extra |
| Codex `notify` (CLI view) | The helper had `DISPATCH_AUTH` in its inherited env (header present, source `env`, own canary). | env inherited | `codex-notify.mjs` reads `DISPATCH_AUTH` |
| Codex shell (Pretty) | Own canary arrived in every thread. | own canary arrives | `shell_environment_policy.set.DISPATCH_AUTH` |
| Codex CLI (PTY) MCP with both `env` and `env_vars` for one server | Accepted. Own canary arrived. Shell also inherited the env canary. | (delivery works) | `env` (non-secret) plus `env_vars=["DISPATCH_AUTH"]` |
| Claude hook | The HTTP `Stop` hook sent `Authorization: Bearer ${DISPATCH_AUTH}` with `allowedEnvVars: ["DISPATCH_AUTH"]`. The daemon saw the own canary. | header arrived | `headers` + `allowedEnvVars` |
| Claude MCP and shell | MCP config env `"DISPATCH_AUTH": "${DISPATCH_AUTH}"` resolved to the own canary. Shell carried the own canary. No canary in `~/.claude`. | (delivery works) | reference in `thread-ID.mcp.json` |
| Grok, Pretty (`grok agent --plugin-dir`) | `${DISPATCH_AUTH}` in `.mcp.json` resolved. MCP and shell carried the own canary. | reference resolved | `${DISPATCH_AUTH}` in `.mcp.json` |
| Grok, CLI view (`GROK_HOME` plugin) | Not testable here. The MCP tool was never called: under `GROK_HOME`, `grok inspect` lists no `dispatch` plugin and "MCP Servers (None)". The shell carried the own canary. See Finding 2. | not testable here | use the Pretty result for the file; fix the plugin discovery separately |
| opencode, two threads at once, `{env:DISPATCH_AUTH}` | Each thread's MCP and shell carried its own canary. No cross-talk. The literal row was not run (the gate does not need it). | reference resolved per thread | `{env:DISPATCH_AUTH}` |

Scan result for every run except the Codex CLI run: no canary in any file modified after the start, in any captured stream, in any event or in any JSON-RPC response.

## Findings the coordinator must read

1. **Codex CLI shell snapshot.** `codex` 0.164.0 writes an env snapshot to `~/.codex/shell_snapshots/` for each CLI start. It contains `export DISPATCH_AUTH=...` and `export DISPATCH_API=...`. The file is mode 0644 and Codex never deletes old ones (96 existed). A live key sits there while the thread runs. The key is dead after the thread ends, but another local user could read it during the run. The gate table row "canary in a rollout, a log or an event" covers this by analogy (a canary in a file the daemon does not control). Chosen delivery for the Codex CLI view: the key file, with only the path in env. Codex Pretty is clean, so it keeps the literal thread config.
2. **Grok CLI view plugin not discovered.** With `GROK_HOME` set to a per-thread home that holds `plugins/dispatch/.mcp.json`, Grok 1.0.67 does not list the plugin, so neither the agency MCP nor the hooks load in the CLI view. The real home keeps plugins in `installed-plugins`. This is not caused by stage 1. The Pretty path (`--plugin-dir`) works. This is outside the gate table.
3. **Sticky key reason.** A Codex thread that is killed during a running turn stays loaded in the shared app-server while that turn runs. A resume in that window attaches to the loaded thread, which keeps the old MCP set and so the old key. A new key per spawn would then be rejected. The sticky key of Task 12 (reuse the same key for a Codex Pretty thread across resume) is required. An idle thread resumed after 3 s or 16 s picked up the new key, so the sticky key is only needed for the running-turn case.
4. The `opencode` service password sits in `service.json` in the opencode config folder. It is not related to this work, but a careless `cat` of that folder prints it.

## Caveats

- The running-turn cases used a `sleep 40` turn killed about 2 s after the shell fixture ran. Both resumes (12 s and 16 s) happened while that turn still ran. A resume after the turn ends would behave like the idle case; this was not measured.
- Zero-turn Codex threads (the anchor Z) fail to resume after an app-server crash. That is existing behavior, not a key issue.
- Hits were attributed by canary label. The probe cannot see a canary that Codex altered or encoded; it searched for the exact 47-character value only.
- `opencode` CLI subcommands that talk to the background service (`auth list`, `models`) hung and printed a port conflict because the owner's v2.1.2 service holds the managed port. `opencode acp` was not affected. The probe processes were stopped by pid.
