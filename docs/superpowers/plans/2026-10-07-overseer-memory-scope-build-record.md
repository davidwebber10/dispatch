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
