# Endless Chat — probe results (Task 1)

Claude Code version: 2.1.296 (Claude Code). Probes ran on 2026-10-13 (macOS, Darwin 27.0.0),
cwd `/tmp/endless-probe/chat` (not a git repo). Request bodies were captured with a local
logging proxy (`ANTHROPIC_BASE_URL=http://127.0.0.1:8899`); OAuth through the proxy worked,
so every finding below comes from the real request bodies. The proxy logged bodies only.

Cache numbers compare turn calls with turn calls (Opus) and compaction calls with
compaction calls (Haiku). The prompt cache is per model; no cross-model comparison is made.

## Request shape in 2.1.296 (applies to every probe)

`claude -p --system-prompt <P>` sends:

| Piece | Content | Varies? |
|---|---|---|
| `system[0]` | `x-anthropic-billing-header: cc_version=2.1.296.6ad; cc_entrypoint=sdk-cli;` | Only on a CLI upgrade |
| `system[1]` | `You are a Claude agent, built on Anthropic's Claude Agent SDK.` | No |
| `system[2]` | `<P>` (our text, verbatim) | No |
| `tools` | built-in tools (+ MCP tools on turns) | No (see below) |
| `messages[0]` (user) | `[<system-reminder> CLAUDE.md block, if any]`, `<system-reminder> # userEmail …`, then our text (`<chat>…`) | userEmail: no |
| `messages[1]` (role `system`, AFTER our text) | `# Environment` block: cwd, "Is a git repository", additional dirs, platform, shell, OS version, model name, agent types; on turns also `# MCP Server Instructions` and the skills listing; ends with `Today's date is 2026-10-13.` | Date: daily. cwd: fixed. |

The date and the cwd are NOT in the system prompt and NOT before `<chat>`. Claude Code
2.1.296 puts them in a trailing system message after the first user message. That
message comes after the view in the token order, so it can not break the cached prefix
(tools + system + view). The second-call cache reads below confirm this.

## (a) Fixed system context

- Baseline (`--system-prompt` only, Haiku, 2 calls): system IDENTICAL (348 chars), tools
  IDENTICAL (81 tools, 105,273 chars, incl. user MCP + claude.ai connectors), user prefix
  IDENTICAL. Injections seen: `~/.claude/CLAUDE.md` text before `<chat>` (user memory);
  userEmail reminder before `<chat>`; trailing system message with the SessionStart hook
  `additionalContext` (explanatory output style + superpowers skill text), `# Environment`
  (cwd `/private/tmp/endless-probe/chat`), MCP server instructions, the skills listing,
  and `Today's date is 2026-10-13.` Usage call 2: input 2, cache_read 39,911,
  cache_creation 14,069.
- Candidate set (compaction variant, Haiku, `CLAUDE.md` with `PROBE-MARKER-7731` created
  between the calls): system IDENTICAL (348 chars), tools IDENTICAL (23 tools, 84,280
  chars), user prefix IDENTICAL (userEmail reminder only); marker leaked: no; text from
  `~/.claude/CLAUDE.md` leaked: no; `MEMORY.md`: no; `gitStatus`: no; hook context: no.
  Date forms found: `2026-10-13` once per request, only in the trailing `# Environment`
  system message (after `<chat>`); `10/13/2026`, `Oct 13`, `Tuesday`: 0. cwd
  `endless-probe/chat`: once per request, same trailing message only.
- Second-call usage (Haiku, compaction set): input 2, cache_read 31,213, cache_creation 1,170.
  (Call 1: cache_read 32,383, cache_creation 0 — warm from an earlier identical run.)
- Second-call usage (Opus, compaction set): input 2, cache_read 30,820, cache_creation 1,168.
  (Call 1: cache_read 0, cache_creation 31,988.) Same IDENTICAL results as Haiku; marker
  not leaked.
- Turn variant (Opus, no `--setting-sources project`, no `--strict-mcp-config`, no
  `--disable-slash-commands`, no `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`; same marker change
  between calls): system IDENTICAL (348 chars), tools IDENTICAL (81 tools, 103,327 chars,
  user MCP servers + claude.ai connectors + plugin MCP loaded), user prefix IDENTICAL
  (userEmail only); marker leaked: no; `~/.claude/CLAUDE.md` text: no; hook context: no
  (`disableAllHooks` holds with user settings loaded). Trailing system message: 33,149
  chars (environment + MCP server instructions + skills listing + date), IDENTICAL between
  the two calls. Second-call usage: input 2, cache_read 39,255, cache_creation 11,608. No
  difference from a server connect/auth state appeared in these two calls (servers that
  need auth — databricks, intelligems — were absent from both tool lists).
- Switches rejected by the CLI: none. Every call exited 0.
- A note on the first candidate-set run: zsh does not word-split `env $ENVV`, so only
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` was set. In that run the project `CLAUDE.md` marker DID
  leak into the user prefix. With the env vars set correctly the marker did not leak. This
  shows that `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` is the switch that blocks project
  `CLAUDE.md`, and that `--setting-sources project` alone blocks `~/.claude/CLAUDE.md` but
  not project `CLAUDE.md`. The implementation must pass env as an object, never a string.
- Injections that could not be turned off:
  - userEmail reminder (before `<chat>`): identical on every call: yes (fixed per account).
  - billing header `system[0]` with `cc_version`: identical on every call: yes (changes
    only when Claude Code upgrades; one cache miss per upgrade).
  - Trailing `# Environment` system message (after `<chat>`): identical on every call: yes
    within a day; the `Today's date is …` line changes once a day. It sits after the view,
    so it does not enter the cached prefix. On turns it is ~33 KB (MCP instructions +
    skills listing) and is re-written to cache every turn (~11.6k cache_creation tokens on
    Opus); on compactions it is ~2.6 KB (~1.2k tokens).
- Not verified here: `CLAUDE_CODE_DISABLE_ORG_MEMORY` (no managed memory on this Mac) and
  the git switches in a git cwd (the probe cwd is not a repo; `~/.dispatch/chat` is not a
  repo either). Both stay in the set; neither changed the request.

STOP gate (Step 12 definition — system prompt, tools, or first user message before
`<chat>` differs or contains a date): PASS. Nothing in those pieces differs between calls
or contains a date.

## (b) Haiku summary

`summary-probe.mjs` as written in the brief (`--model haiku --effort <e> --system-prompt
<3.6 KB> --no-session-persistence --strict-mcp-config`, 24 KB `<chat>` + ~2 KB message).
Note: these latency numbers come from the brief's script as written, without the isolated
compaction set (no `--settings`, `--setting-sources project`, `--disable-slash-commands`,
or the `CLAUDE_CODE_DISABLE_*` env), so user plugins, hooks, and skills were loaded.
Runs 2–5 per effort (run 1 writes the cache):

| effort | exit | median wall ms (5 runs) | ttft ms (runs 2–5) | input | cache read | cache write | output (runs 2–5) | reply bytes (runs 2–5) |
|---|---|---|---|---|---|---|---|---|
| max | 0 ×5 | 32,992 | 32,280 / 27,175 / 44,401 / 26,154 | 2 | 34,946 | 0 | 7,022 / 6,738 / 10,915 / 5,787 | 110 / 113 / 168 / 105 |
| xhigh | 0 ×5 | 16,842 | 16,301 / 7,030 / 12,026 / 16,028 | 2 | 34,946 | 0 | 3,309 / 1,391 / 2,355 / 3,378 | 228 / 98 / 128 / 173 |
| high | 0 ×5 | 5,940 | 4,827 / 4,755 / 3,363 / 7,518 | 2 | 34,946 | 0 | 928 / 949 / 617 / 1,379 | 107 / 148 / 149 / 129 |

Run 1: max 51,277 ms (cache_write 34,946); xhigh 20,027 ms and high 9,364 ms (cache_read
22,776, cache_write 12,170). Almost all output tokens are thinking tokens (max run 2:
6,985 of 7,022). `ttft_ms` is close to `duration_ms` because the first text token comes
after the thinking. Every reply was ≤ 310 bytes (limit 512).

The mechanical rule gives the two lines below. The controller overrode them; see "Chosen set"
(claude/high).
- Rule result, SUMMARY_EFFORT: max (the highest effort that exits 0 for Haiku).
- Rule result, Engine: openrouter (rule: openrouter when the median wall time > 5,000 ms; max median is
  32,992 ms). Note: no effort meets the 5,000 ms rule; `high` is closest at 5,940 ms.

## (c) Hand-off and deny-all

Ran through the built `ClaudeStructuredSessionManager` (`--permission-mode default
--permission-prompt-tool stdio --model haiku --strict-mcp-config`).

- Mid-turn message: injected before the first result. Timeline: `tool_use:Bash` at +2.1 s,
  second user message sent at +2.5 s, Bash `tool_result` at +8.8 s, then `text: DONE. BANANA`
  and a single `result` at +9.2 s. No second turn.
- can_use_tool reached for: Read (two times; both denied with the policy message, which
  the model got as the tool result). Glob: not a tool in 2.1.296 (`No such tool available:
  Glob`), so no permission request. Tools that ran with no can_use_tool: Bash (the model
  fell back to Bash after the denies; Claude Code auto-allowed it with no `control_request`
  — most likely a read-only command auto-approval). The deny-all policy therefore can NOT
  stop every tool. The summarizer's abort-on-`tool_use` guard (Task 5) is the only
  reliable guard; record it as required.

## FTS5

- macOS bundled: `fts5 ok 3.49.2` (better-sqlite3 11.10.0).
- Linux prebuilt: not run here, reason: the Docker daemon is not running. The
  better-sqlite3 Linux prebuilds compile the same bundled SQLite amalgamation with the same
  flags (`SQLITE_ENABLE_FTS5` is on in its `deps/defines.gypi` for every platform; checked
  at line 24 of the installed copy); Task 20 checks it on the WSL2 host.

## Chosen set

Shared by turns and compactions:

- FIXED_CONTEXT_ARGS: `['--system-prompt', <fixed text>, '--settings', JSON.stringify(FIXED_CONTEXT_SETTINGS), '--no-session-persistence', '--disallowedTools', 'AskUserQuestion']`
- FIXED_CONTEXT_SETTINGS: `{ "autoMemoryEnabled": false, "includeGitInstructions": false, "disableAllHooks": true }`
- FIXED_CONTEXT_ENV: `{ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_ORG_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' }`

Compactions only (isolation; turns keep the user's MCP servers, connectors, plugins and
skills — option B):

- COMPACTION_ISOLATION_ARGS: `['--setting-sources', 'project', '--strict-mcp-config', '--disable-slash-commands']`
- COMPACTION_ENV: FIXED_CONTEXT_ENV plus `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1'`, that is
  `{ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_ORG_MEMORY: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' }`

Not usable: `--bare` (API key only; breaks subscription billing);
`--exclude-dynamic-system-prompt-sections` (ignored with `--system-prompt`; not needed —
the dynamic sections already trail the first user message in 2.1.296).

- SUMMARY_EFFORT: 'high'
- SUMMARY_ENGINE: 'claude'
- Controller ruling: claude/high accepted as the exception to the 5,000 ms rule (high median 5,940 ms); the openrouter switch stays available in summarizer-choice.ts
- Mid-turn hand-off: a message written to stdin during a tool call is injected into the
  running turn; it is answered before the first `result` (no second turn).
- Deny-all on compactions: `toolPolicy` denies Read, but an auto-approved Bash call runs
  with no `can_use_tool`. Abort on any `tool_use` in a compaction.

## End-to-end (Task 19)

Isolated daemon: `HOME=/tmp/endless-e2e/home` (a symlink mirror of the real home with a
fresh `.dispatch`), `PORT=3999`, `DISPATCH_ENDLESS_LIMITS=4000,8000,2000,4000`. Real Opus
turns and real Haiku compactions. Driver: `/tmp/endless-e2e/run.mjs` (brief Step 2).

- Messages: 50 notes over 2 project tags (`alpha`, `beta`), 0 failed turns; 3 more question
  turns, then 2 restart turns; 113 messages in the log at the end. After the 50 notes
  (100 messages): view 28 lines, 4,883 bytes, levels 0,1,2,3,4; placeholders 0. The view
  merged at least once on every level from 1 to 4. The tree was complete: 105 nodes on
  levels 1–6, 0 missing. Haiku compaction calls: 27 before the restarts.
- Deep zoom (HTTP): 4 levels, from `0+16` to the whole message
  `#0 user (alpha): Note 0: the red item in this project has code C1000. …`
- Search C1021: `7:beta, 6:beta` (the user note and the reply). The project filter narrows
  the hits: `C1021` gives 6 hits for All, 0 for `alpha`, 6 for `beta`; `amber` gives 24 for
  All, 10 for `alpha`, 14 for `beta`.
- Model zoom: the brief's question ("What was the code of note 3?") gave 0 zoom calls,
  because the level-4 summary line `0+16` still holds every code. The reply was correct:
  "Note 3 gave code **C1021**, for the amber item in beta." A question for the exact words
  of the reply to note 3 gave 1 zoom call (`mcp__memory__zoom {"id":7,"n":1}`, after one
  `ToolSearch` call to load the deferred tool). Reply: "Noted: the amber item in beta has
  code C1021." This is the exact text of message #7.
- MCP process zoom (Step 3): with the brief's `printf … |` pipe, the process prints only the
  `initialize` line. `memory-mcp.ts` line 132 calls `process.exit(0)` on stdin `close`, so
  the in-flight `tools/call` is lost. With stdin held open (`(printf …; sleep 3) |`) the
  second line comes: `#0 user (alpha): Note 0: the red item in this project has code
  C1000. …`. Claude Code keeps stdin open during a session, so real turns are not affected.
- Rendered view: the Memory inspector text equals `GET /api/endless/view` `rendered`
  (6,290 characters, 38 lines). Spot check: a turn copied the first 3 lines of its own first
  user message; the 687 copied characters are an exact prefix of `rendered`.
- Turn cache-read ratio (Opus, median of 53): 0.420 (range 0.000–0.800; p25 0.410, p75
  0.433). Each turn reads 11,365 tokens and writes 14,135–17,201 tokens. The write grows
  by about 71 tokens per message pair and falls after a merge, so the view is in the
  written part on every turn. The view is not read from cache. See the note below.
- Compaction cache-read ratio (Haiku, median of 27): 0.853 (range 0.000–0.943; p25 0.843,
  p75 0.866). Each call reads 17,398 tokens and writes 2,394–3,017 tokens.
- Haiku compaction wall time (process start to exit, sampled every 200 ms): median
  5,059 ms over 28 processes (range 3,088–48,253 ms; 4 over 10 s). Opus turn processes:
  median 4,906 ms over 54 (range 3,621–9,408 ms).
- Restart mid-compaction: killed at `compactor.running 1`, `merges 1`, turn `running`
  (reply #111 already logged). After the restart: turn `interrupted`, the compactor started
  again with no new message and drained in 28.4 s (3 compactions). 112 messages, 0 missing
  nodes on levels 1–6.
- Restart mid-turn: killed 22 ms after the turn went `running`. After the restart: turn
  `interrupted`, user message #112 kept, no reply logged, 0 missing nodes, no orphan
  `claude` processes. The UI shows "The daemon restarted during the last turn, so the turn
  stopped." with a Retry button.
- UI checks (Chromium, Playwright):
  - Messages render with `alpha`/`beta` tags, replies as text, no raw JSON: pass.
  - Filter `All`/`alpha`/`beta`: pass (`beta` shows only odd notes 1–19 in the window).
  - Older messages load: pass (`messages?before=50&limit=60` fetched after the first page).
  - Search `C1021` lists 6 results: pass.
  - Tap a result opens the chat at that message with a highlight: FAIL from the tail, pass
    from the middle. See the bug below.
  - Memory button shows `<chat>` lines `0+16|…`, no placeholder: pass.
  - Projects panel lists both projects: pass.
  - 390 px: `scrollWidth` 390 = `innerWidth` 390 (no horizontal page scroll); the 6 bottom
    tabs are 65 px each with 0 px label overflow: pass. Desktop 1400 px layout: pass.

Bug — search jump from the tail does not scroll. Steps: open Chat (the view is at the
newest message), search `C1021`, tap the result `beta · user` (message #6). Result: the
client fetches `messages?around=6&limit=60` and puts the accent outline on message #6, but
the viewport stays at the bottom of the new window (`scrollTop` 2,880 of max 2,880; message
#6 is 2,292 px above the viewport). Scroll to the middle first and tap a result: the target
is centered (318 px from the top of a 674 px viewport). A probable cause is the
`MessageScroller` `autoScroll`/end anchor in `EndlessColumn.tsx`, which pulls the viewport
back to the end after `scrollIntoView`.

Note — the turn prompt cache does not hold the view. Each turn is a new `claude -p`
process, and Claude Code writes the cache only at the end of the whole prompt. The view, the
status block and the new user line change on every turn, so turn N+1 never finds the
prefix that turn N wrote. Only tools + system prompt (11,365 tokens here) are read. The probe
in section (a) sent two identical calls, so it did not show this. With the default view
limits the view is larger, so the cache write per turn is larger.
