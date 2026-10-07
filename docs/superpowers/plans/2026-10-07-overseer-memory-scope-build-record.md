# Overseer memory scope — build record

Spec: `docs/superpowers/specs/2026-10-07-overseer-memory-scope-design.md` (approved 2026-10-07).
Branch `feat/overseer-memory-scope`, based on `main` at v2.44.1. Built with TDD from the spec, with
no implementation plan. This file records what the spec left open.

## Commits

| Commit | Unit |
|---|---|
| `4c2459a` | Unit 1: the Claude overseer's own memory folder |
| `43e625b` | Unit 2: the write scope is a list of folders |
| `5c8542e` | Unit 3: the persona paragraph |
| `a0c7a7a` | Unit 4: the `thread` source kind |
| `d4fe3ae` | Unit 5: project rules as one line |

## Decisions where the spec was silent

Safety (home folder):
- Every function that touches a memory folder takes the home folder as a parameter
  (`overseer/memory-scope.ts`). The session service gets it from `setOverseerMemoryHome(home)`.
  Only `startServer` calls it, with `os.homedir()`. `createApp` and every test service leave it
  unset: then no folder is created, no note is copied and no `--settings` flag is passed. Reason:
  a test that spawns an overseer can never write into a real home, even without a private HOME.
- The write policy and the folder line of the persona are always computed. Without a memory home
  they use `os.homedir()`, but only to resolve and name paths, never to write.

The folder and the copy (Unit 1):
- The project folder is the thread's working directory (`terminal.working_dir`, else the
  project's). That is the directory Claude runs in, so the shared folder is the one Claude itself
  would use. The encoding is `encodeClaudeProjectDir`.
- "An overseer of this project" means a coordinator terminal of the same Dispatch project (session),
  active or archived, with a known `external_id`. Notes of agents and of the user's threads stay.
- Only top-level regular `*.md` files other than `MEMORY.md` are candidates. A symlink, a folder
  or another file type is skipped. `originSessionId` counts only inside the leading frontmatter.
- The index copy keeps the lines that contain `(name.md)` or `(./name.md)` for a copied note. No
  header is added. When no line matches, no `MEMORY.md` is written.
- After the copy, a marker file `.dispatch-copy-done` lists the copied notes. Reason: a first
  start that finds no notes must not copy at a later start, when the overseer's deliberate shared
  notes ("From the overseer:") exist. A folder that already holds any file is never seeded.
- A failed copy is logged and never stops the start; the folder is still passed.
- The flag rides the real command only. The test seam `structuredCommandOverride` skips it.

Write scope (Unit 2):
- `makeCoordinatorPolicy` takes only a list. `coordinatorWriteDirs(harness, home, projectDir)`
  gives each harness its list; any other harness falls back to the Claude list.
- `coordinatorMemoryRelDir('claude-code')` is now `.claude/dispatch-overseer`, the root of the
  own folders. The persona label comes from it, so the label and the policy cannot drift apart.
- The unused default export `coordinatorToolPolicy` (all of `~/.claude`) is removed.
- The deny message names every allowed folder.

Persona (Unit 3):
- The paragraph is one "MEMORY:" bullet after the rule about saving rules in memory.
- The Codex variant replaces only the label `~/.claude/dispatch-overseer`, not every `~/.claude`.
  The shared folder `~/.claude/projects` stays in both variants. The pinned test "the Codex
  variant never mentions ~/.claude" now says "only as the shared folder".
- Each start appends one line with the exact folders of that start:
  `Your memory folder: … The project’s shared memory folder: …`. Reason: the persona is
  static, and an overseer (Codex above all) cannot read the shared folder without its path.
  `buildCoordinatorPrompt` without folders is unchanged, so the six Codex markers and the
  byte-identical Claude pin hold.

Ledger (Unit 4):
- A `thread` source is any thread of the project whose role is neither `agent` nor
  `coordinator`, archived ones included, by ID or label. It stores the label.
- With a section, the card reads `your thread "<label>", section "<section>"`, as the agent form.
- `agent` already refused the user's own threads. The build only pins it, by ID and by label.
- `ledger_decide_self` accepts a `thread` source; the spec does not limit it.

Rules (Unit 5):
- The one line shows in every `ledger_list` text, with or without `forRecap`.
- The `rules` field is a list of strings, one rendered rule each. The dispatch MCP returns it as
  a second text block that starts `Project rules in force, for your own use: apply them, and do
  not paste them.` The first block is still the text to paste.
- `ledger_show({ rules: true })` wins over `ids` and `all`. With no rules it prints
  `No project rules.`
- A new rule still shows once under "Decided since the last recap", as every new statement does.
  That is one line, not the full list.

## Deviations

None from the spec. Check 2 (can a Codex overseer read the Claude folder) stays open. On
instruction, no live test started Codex or Claude.

## Tests

- Core: 231 files passed, 1 skipped; 2582 tests passed, 4 skipped (baseline 228 files, 2535
  tests). One full run had one failure in `tests/routes/terminals.test.ts` (auto-archive, a plain
  thread that this work does not touch). That file passed 3 times alone, and the next 2 full runs
  passed.
- Web: 150 files, 1285 tests passed (no web change).
- Typechecks: `packages/core` `tsc --noEmit` and `packages/web` `tsc -b` pass.
- Every run used a private TMPDIR and HOME. The new tests use `fs.mkdtempSync` folders and mock
  `os.homedir` to them.

## Review round 1

Findings of the code review (Fable code-reviewer and GPT-6-astra), fixed with TDD in one commit.

1. **The shared folder follows the git repository.** `claudeMemoryProjectDir(workDir)` runs
   `git rev-parse --path-format=absolute --git-common-dir --show-toplevel` in the working directory
   (argument array, 2 s timeout, `GIT_DIR` and its kin removed from the environment). The main
   root is the parent of the common `.git` dir, so a subfolder and a worktree give the main
   checkout. Outside a repository, or when git fails, it is the working directory. Both are
   canonical (`fs.realpathSync.native`). When the common dir is not named `.git` (a submodule),
   the top level is used; that case is not checked against Claude Code. The own folder stays
   keyed by the working directory, as the spec says "encoded project dir" for it.
2. **Symlinks.** The own folder must resolve inside `~/.claude/dispatch-overseer` and the shared
   folder inside `~/.claude/projects`, through symlinks (`resolvesInside`, with `realResolve` and
   `isUnder` moved unchanged from `coordinator-policy.ts` to `overseer/real-path.ts`, to avoid an
   import cycle). A refused folder is left out of the policy and the persona line, and one
   `console.error` line names it. A refused own folder also means no `--settings` flag: that
   overseer starts as before this change. A refused shared folder means no copy and no marker. A
   symlinked `~/.claude` itself is followed, as both roots resolve through it.
3. **The copy can resume.** The marker comes only after a pass with no error. Without it, a start
   copies only the missing notes (`wx`, never an overwrite) and adds only the missing index lines
   to the own `MEMORY.md`. The old rule "a folder with any file is never seeded" is gone.
4. **Bounds.** At most 8 KB is read to find the origin, a note over 1 MB is skipped (one log line
   per start for all of them), and a start handles at most 500 notes. Notes open with
   `O_NOFOLLOW` and `O_NONBLOCK`; an index line matches through a Set of note names. Decision: a
   start that reaches 500 writes a cursor file `.dispatch-copy-cursor` (the last name handled) and
   no marker, so the next start goes on after it. Reason: "per start" in the spec, and a retry
   without a cursor would read the same 500 notes again at each start.
5. **A missing home is not silent.** A Claude overseer that starts on the real command with no
   memory home logs one `console.error` line. A test reads `startServer` in `server.ts` and fails
   when the `setOverseerMemoryHome(os.homedir())` line is gone. The opt-in default is unchanged.
6. **Codex persona.** The Codex variant says `Read it at each start.` instead of
   `It loads at each start.` The replaced string is now the seventh pinned marker.
7. **Index form `(./name.md)`:** now tested.
8. **`ledger_decide_self` refuses a `thread` source**, with and without `id`, with
   `Only the user can decide this item.` This replaces the Unit 4 decision above.

Tests: core 231 files passed, 1 skipped; 2605 tests passed, 4 skipped. Web 150 files, 1285 tests.
Both typechecks pass. Flakes seen, each in a test that starts no coordinator:
`tests/routes/terminals.test.ts` (once in a full run; then 3 of 3 alone),
`tests/routes/structured.test.ts` (once in a full run and once in 3 runs alone, the
noteDeclaredStatus test on a plain thread; then 13 of 13) and `tests/routes/auth.test.ts` (once in
a full run; then 5 of 5). The last full core run had no failure.

## Review round 2

Findings of the GPT-6-astra round-2 review, fixed with TDD in one commit.

1. **A git failure is not "outside git".** `gitRoots` gives one of three results: `repo`,
   `none` (only when git prints `fatal: not a git repository`, with `LC_ALL=C`), or `failed`
   (a timeout, a missing or unreadable folder, a bare repository, any other error or output).
   `claudeMemoryProjectDir` returns `{ dir: null, reason }` on `failed`. Then the start logs one
   line, the shared folder is left out of the write scope and the persona, and
   `prepareOverseerMemory` sets up the own folder but copies nothing and writes no marker. The
   next start tries again. Decision: a folder that does not exist is `failed`, not `none`, as
   git did not say so.
2. **Unusual layouts and exact paths.** A common dir not named `.git` is `failed` (logged,
   deferred). This now includes a submodule, which round 1 keyed on its top level. Reason: the
   rule names every such layout, and Claude's folder for a submodule is not verified either.
   Git's output loses only its one trailing newline; output that is not exact UTF-8 or not two
   absolute paths is `failed`.
3. **The cursor is exact and checked.** Only one trailing newline is stripped. The cursor counts
   only when it is the exact name of a note in the current sorted list; otherwise the copy
   starts at the beginning (one log line), and the marker comes only when every note was
   handled. A cursor path that is a folder, a symlink, another file type or unreadable is
   ignored (one log line), and the copy is not marked done while it stays. Known limit: with
   more than 500 notes and such a cursor path, each start handles the first notes again.
4. **Root symlinks are not trusted.** The anchor is the canonical `<home>/.claude`: the own folder
   must resolve under `<canonical .claude>/dispatch-overseer` and the shared folder under
   `<canonical .claude>/projects`, and neither root may be a symlink (`lstat`). A symlinked
   `.claude` with real subfolders still works.
5. **Less work on the start path.** A start copies at most 16 MB of note bytes; the rest goes on
   at the next start through the cursor. The first note of a start always goes, so each start
   moves on. A shared or own `MEMORY.md` over 256 KB is not read: its lines are not copied, and
   the one size line names it. Decision: an index over the bound is skipped, not read in part,
   as a note over 1 MB is. Git and the copy stay on the event loop (out of scope).

Tests: core 231 files passed, 1 skipped; 2623 tests passed, 4 skipped. Both typechecks pass.
