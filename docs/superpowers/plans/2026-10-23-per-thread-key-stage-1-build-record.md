# Per-thread keys, stage 1: build record, Task 22 (restart mid-work test)

Date: 2026-10-23 to 2026-10-24 (UTC). Plan: `2026-10-23-per-thread-key-stage-1.md`, Task 22. Spec: section 9.

**Verdict: PASS for the stage 1 gate, with two harness gaps that come from the test environment and not from the code (Grok model quota, Grok CLI view plugin). No repo code changed during this run.**

## Run facts

| Item | Value |
|---|---|
| Build under test | branch `feat/per-thread-key-stage-1`, head `d1d91e2a` (built with `pnpm build`, no errors) |
| Scratch folder `S` | `/tmp/ptk-s1.0oKdCz` |
| Port `P` | 3490 (free, never 3456) |
| Fake HOME | `$S/home` (fresh `.dispatch`; symlinks to the real CLI homes and the macOS keychain folder; all unlinked at the end) |
| Clean env | `$S/clean` (`env -i` with HOME, USER, LOGNAME, SHELL, LANG, TERM, PATH only); no `DISPATCH_*`, `BROWSER` or live shim path reached the daemon (checked with `ps eww` and from inside a shell tab) |
| Tools | node 24.14.0, pnpm 11.5.2, macOS (Darwin 25.6.0) |
| CLIs | claude 2.1.309, codex 0.164.0, grok 1.0.67, opencode 2.1.3 |
| Models | Claude `haiku` (coordinator `sonnet`, set by the daemon), Codex `gpt-5.6-luna`, Grok default, opencode `openrouter/~google/gemini-flash-latest` |
| Restarts run | R1 clean (`kill -TERM`), R2 hard (`kill -9`), Codex app-server `kill -9`, Codex quick restart, R3 clean (data comparison only) |
| Times (UTC, 2026-10-24) | R1 daemon back 00:51:18; R2 kill 01:03:01, back 01:04:34; app-server kill 01:14:46; quick restart 01:16:38; R3 back 01:20:01 |

Work in progress at the barrier before R1 and R2 (all true at the same moment, read with the barrier script): eight interactive threads plus one plain peer in project A, a coordinator with a running worker and a queued item, a role run (finished, report stored), a scheduled run (notes file growing), a Chat turn (`running`), a Chat-spawned worker in project B, and a detached `whoami` loop (the witness) started by a Pretty thread. Threads wrote 100 to 1500 numbered lines each. The Codex Pretty threads ran the whole loop in one script cell.

## Pass table per condition and restart

Conditions are step 15 of the plan. R1 = clean stop, R2 = `kill -9`.

| # | Condition | R1 clean | R2 hard kill | Evidence |
|---|---|---|---|---|
| 1 | No false refusals | PASS | PASS | Every `[keys] refused` line after R was either the witness key hash (no terminal id) or one of my own deliberate probes (old-key `whoami` checks, the forged calls of condition 8). No refusal names a live test thread for a normal call. Whole run: 62 unknown or revoked key lines on `GET /api/whoami`, 6 deliberate `thread` refusals. |
| 2 | Everyone came back | PASS (Grok: see gaps) | PASS (Grok: see gaps) | Each thread saved a new key file and ran `list_threads`, `message_thread` and `report_status` with no 401 or 403 (conversation scan: 0 key errors in any readable thread). Coordinator resumed by the kickstart after R1 (`resumed 1 interrupted thread(s); skipped 2`) and ran `ledger_list`, a cross-project `list_threads` read (PK-4) and `read_agent`. Chat answered its next message through the memory MCP. The stored `lastOutcome` shows the new summary only for threads whose turn ended (it is written at turn end); busy loop threads show the `report_status` call in the conversation instead. |
| 3 | Every helper sent a key | PASS | PASS | `GET /api/access/no-credential-stats`: `program` total 0 and `browser` total 0 since each restart (this includes the Claude HTTP hook and the Codex notify helper). No row was left without a key. |
| 4 | New keys, old keys dead | PASS | PASS | For every key-holding thread the previous `LABEL` and `LABEL-N` keys gave 401 and the new key gave 200 (cc-cli, cc-pretty, cx-cli, cx-pretty-1, cx-pretty-2, gk-pretty, gk-cli, oc, coordinator, worker, chat-worker). |
| 5 | Orphan job locked out, its thread fine | PASS | PASS | Witness log: 205 lines `200` before R1; 9 `ERR` while down, then only `401` (140 lines); R2: 18 `ERR`, then only `401` (176 lines). `cc-pretty` met condition 2 both times. |
| 6 | Data is the same | PASS | PASS (see note) | Labels, transport, spawn depth, model, external id, ledger note `e2e-alpha`, terminal rows and the project note files unchanged; files only gained appended lines. Conversation counts: the early snapshots used the default window of the route, so they cannot show "never lower"; R3 (clean, no revive) used the full history: items up to the cutoff identical for all 18 threads, totals equal or higher, project files kept their earlier lines as a prefix. |
| 7 | Nothing stuck | PASS | PASS | 10 minutes after R2: every loop thread still wrote lines, no thread needed a manual relaunch, no queued item was lost (`queued3` and `queued4` stayed `queued` until started, then got a key and ran). One observation under "Findings". |
| 8 | Forged calls still fail | PASS | PASS | With a Pretty thread key: `POST /api/secrets` gave `403 owner_only`; a message with `source: user` gave `403 identity_mismatch`. With the worker key: a ledger write gave `403`, a ledger write as the coordinator gave `403 identity_mismatch`, a read of project B gave `403 out_of_scope`. The coordinator key read project B (200). |

## Pass table per harness and view

"Pre" = before R1. A cell with a number is the key file index that the thread wrote itself; all of those calls (save-key, `list_threads`, `message_thread`, `report_status`) succeeded unless the note says otherwise.

| Thread | Harness and view | Key delivery observed | Pre | R1 | R2 | Notes |
|---|---|---|---|---|---|---|
| cc-cli | Claude Code CLI | `DISPATCH_AUTH`, MCP reference | PASS | PASS | PASS | |
| cc-pretty | Claude Code Pretty | `DISPATCH_AUTH`, MCP reference, hook header | PASS | PASS | PASS | also runs the witness job |
| cx-cli | Codex CLI | `DISPATCH_AUTH_FILE` (key file), `env_vars` in argv, no literal key | PASS | PASS | PASS | save-key helper works through the file; new key each restart |
| cx-pretty-1 | Codex Pretty | literal key in thread config, sticky | PASS | PASS | PASS | same key after the app-server crash and the quick restart |
| cx-pretty-2 | Codex Pretty | same, shares the app-server with cx-pretty-1 | PASS | PASS | PASS | same key after the app-server crash |
| gk-pretty | Grok Pretty | `DISPATCH_AUTH` in the agent env, `${DISPATCH_AUTH}` in the plugin MCP file | PASS (`list_threads` returned 11 threads) | key only (see Gaps) | key only | model quota exhausted after the first phase |
| gk-cli | Grok CLI | `DISPATCH_AUTH` literal in the PTY env | shell only | key only | shell only | not testable for MCP tools: the per-thread home lists no `dispatch` MCP; save-key through the shell tool worked before R1 and after R2 |
| oc | opencode Pretty | `{env:DISPATCH_AUTH}` | PASS | PASS | PASS | R1 and R2 calls verified in the opencode session store: roster of 16, `report_status` ok |
| peer | Claude Code Pretty | `DISPATCH_AUTH` | PASS | PASS | PASS | received the `ping` messages |
| Overseer | coordinator | `DISPATCH_AUTH` | PASS | PASS | PASS | cross-project read allowed, ledger write allowed |
| worker | Claude agent (depth 1) | `DISPATCH_AUTH` | PASS | PASS | PASS | cross-project read refused |
| queued, queued2 | queued agents | key at start | PASS | n/a | n/a | the coordinator started them when the worker went idle between turns |
| queued3, queued4 | queued agents created by the owner call | key at start | n/a | PASS (started after R1) | PASS (started after R2) | stayed `queued` across the restart, no key before start |
| role run | scheduled role | key per run | PASS | PASS (new run, new `role-*` file) | PASS | `list_threads`, `watch_thread`, `report_status` ok, no tool outside the allowlist |
| scheduled run | scheduled agent | key per run | PASS | PASS (new run) | PASS (new run) | earlier `sched-*` keys give 401 |
| chat-worker | Chat-spawned worker (project B) | `DISPATCH_AUTH` | PASS | PASS | PASS | |
| Chat | Chat turn | Chat key | PASS | PASS | PASS | turn was `running` at the barrier; next Chat message after each restart listed the project B threads and the worker status |
| shell tab | shell | `dsk_` key, `DISPATCH_API` and `DISPATCH_SERVER_URL` hold port 3490, `PATH` starts with the fake home shim, no value holds 3456 | PASS | n/a | n/a | `dispatch-open` created an auth request with the shell's terminal id |

## Codex app-server crash (step 17)

`kill -9` of the app-server child of the daemon (parent pid checked first), with both Codex Pretty threads in their loops. The manager started a new app-server. Each thread then wrote `LABEL-4`, called `list_threads` and `report_status`.

- PASS. `cx-pretty-1-4` and `cx-pretty-2-4` are byte-identical to `LABEL-3` (sticky key), both answer 200, every call succeeded, no refusal line names either terminal. `cx-pretty-2` then finished its loop to 1500.

## Codex quick restart (step 18)

On `cx-pretty-1`, while in its loop: `POST /api/terminals/ID/relaunch`, then `LABEL-5` save-key, `list_threads`, `report_status` within 10 seconds; 30 seconds later `list_threads` again; `POST .../stop`; revive by a message after 3 seconds; `list_threads` and `report_status`.

- PASS. `LABEL-5` equals `LABEL-3` (sticky key), every call succeeded, no refusal for the terminal. After the archive (`DELETE /api/terminals/ID`) both `LABEL-5` and `LABEL-3` gave 401 at once.

## Leftover processes after the hard kill (R2)

62 descendants of the daemon were recorded read only before the kill. After `kill -9` only three were left: the Chat `claude -p` process (it was in the middle of a turn), its overseer memory MCP `node` child, and a `zsh -c` shell child of the Chat process. All three had a cwd under `$S`. They were killed by pid in the loop (one pass found them, the second found nothing). Every PTY child and every other structured child, including the Codex app-server, had exited on its own. No leftover after the clean stop (R1), after R3, or at the end of the run.

## Chat

At each barrier `GET /api/endless/state` showed `turn.status: running`. After R1 and R2 a new Chat message was answered: the Chat listed project B and reported the worker status through its memory MCP (`list_threads`), so the Chat key worked after both restarts. A Chat-spawned worker (project B) kept working with its own key.

## Detached witness job (`nohup` equivalent)

Started by `cc-pretty` through `whoami-loop.mjs` (a detached child in its own process group, pid file written by the job). Result as expected: `200` before R1; during each restart a few `ERR` lines; only `401` after each restart; one stray `401` right before each restart finished when the new daemon was already listening. The thread that started it was not affected. The job was killed by pid as the last process of the teardown.

## Findings and failures (none needed a code fix)

| # | What happened | Cause | Action |
|---|---|---|---|
| F1 | Claude said "Not logged in" under the fake HOME | The macOS keychain is found through `HOME/Library/Keychains`; the plan's symlink list lacks it | Added the symlink `$S/home/Library/Keychains` (read access to the same keychain), unlinked at the end. Step 3 of the plan should list it. |
| F2 | Grok returned `429 free-usage-exhausted` (`stop_reason: rate_limit`) from the first restart on | Grok model quota of the test account, for the thread's reasoning level | Environment limit, not a code failure. Grok restart checks reduced to key delivery (see Gaps). |
| F3 | A Grok CLI thread cannot be created through the API on this build (`409 Requested harness transport is disabled`) | Grok is Pretty-only in the catalog (legacy CLI rows still run) | Created a Grok Pretty row, stopped it, and set `config.transport` to `pty` in the throwaway database, which is what a legacy row looks like. Plan step 8 should say this. |
| F4 | Text that `message` typed into the Claude, Codex and Grok CLI views was not submitted; the CLI trust dialogs of Claude and Grok blocked the first start | The submit carriage return arrives in the same write as the text (existing behavior; `pty-message.ts` is unchanged by stage 1). Trust dialogs are per folder | Sent one extra Enter (`POST .../input`) after each CLI message, and answered the trust dialogs once. |
| F5 | The Grok CLI view cannot call Dispatch tools | The per-thread `GROK_HOME` holds only `plugins/dispatch/hooks`, no MCP file (probe finding 2). The thread's own transcript shows it searched and found none | Marked "not testable here". Not a stage 1 regression: with no key it behaves as before. Its shell tool ran save-key (key file written, key valid). |
| F6 | The scheduled run killed by a restart keeps its run row at `working` while its thread row is `error`; the new run is a separate row | `agents/service.ts` has no reconcile for interrupted runs; stage 1 touched that file only for redaction | Observation, pre-existing, not a regression. A follow-up for the board, not a gate item. |
| F7 | `opencode run` from the shell failed with "managed service port already in use" | The owner's background opencode service holds the managed port | Used the Dispatch ACP path instead (as the probe results note). Verified by the opencode session store. |
| F8 | A coordinator-queued agent with `dependsOn` the worker started while the worker was idle between turns | The dependency is met when the worker is not `working`, and the worker's loop ran in a background shell | Used owner-created queued items (`queued3`, `queued4`) for the "stays queued across a restart" check. |
| F9 | Operator slip: the leftover scan of the final teardown ran from a shell whose cwd was under `$S`, so it listed and killed that shell | The scan matches any cwd under `$S` | No harm (the shell only). Run scans from `/tmp`. |
| F10 | Test side effects outside the scratch folder | The CLIs record folder trust in the real homes through the symlinks | A trust entry for the temporary folder was written to the owner's `~/.claude.json` and `~/.codex/config.toml`, and the CLIs' own session histories hold the test threads. Left as is (editing a sign-in adjacent file is riskier than leaving a dead path). |

No daemon log line contained a key (`rg` of the log for `dtk_`, `dck_`, `dsk_` found none before deletion of the home).

## Gaps (honest scope of the PASS)

1. **Grok Pretty and Grok CLI after the restarts.** The model quota ended the model turns, so no Grok model call happened after R1. What was verified instead: the new Grok process after each restart carries a new key in its environment (read from the process environment by the operator, never printed), that key answers `GET /api/whoami` with 200 for the right terminal, and the previous key answers 401. After R2 the Grok CLI shell tool also wrote its own new key (`gk-cli-3`). The Grok Pretty MCP path worked before R1 (`list_threads` returned the roster). The Codex and Claude rows prove the same server code path for the other harnesses; the Grok-specific piece that is not proven after a restart is the `${DISPATCH_AUTH}` expansion in the plugin MCP file on a resumed session. Suggest a rerun of only the two Grok rows when the quota resets.
2. **Grok CLI view MCP tools.** Not testable (F5).
3. **Round-trip evidence for Pretty threads that stay in one long turn** is the `report_status` call in the conversation, not the stored `lastOutcome` (F-note under condition 2).

## Teardown

Daemon stopped with `kill -TERM`, leftover scan found nothing, the witness was killed last by pid, port 3490 is free, no `whoami-loop` process remains. Key files, the owner header file and the shell environment capture were deleted. Every symlink in the fake home was removed with `unlink`, including the ones that the Grok per-thread homes made into the real Grok home (the real sign-in files were checked afterward: Claude, Codex and Grok sign-ins intact). `daemon.log` and the snapshot files stay in the scratch folder.
