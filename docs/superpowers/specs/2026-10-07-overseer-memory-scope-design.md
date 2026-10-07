# Overseer memory scope — design

Date: 2026-10-07. Approved by the user on 2026-10-07 ("spec is good to go. proceed to
implementation"). Thread "Opus 5.5 Xhigh Handle Business". Follows the decision cards spec
(`docs/superpowers/specs/2026-10-06-overseer-decision-cards-design.md`).

## Goal

An overseer loads only its own memory at each start. It can still read the notes and the
history of the user's own threads whenever the user asks or a task needs them. Anything it
takes from those threads keeps its origin. When the user's threads must know something, the
overseer writes a note for them on purpose. This works the same way for Claude and Codex
overseers.

## Decisions so far

1. **A middle ground, not a wall** (user, 2026-10-07: "i want to find a happy medium here.
   i often work in CP on larger and more broad items within a project and spin up new threads
   for smaller or time sensitive work. there is interplay between both and i don't want to
   completely restrict the overseer from accessing threads history"; then "start b").
2. **Claude and Codex overseers both** (user: "what about codex overseers? will all of this
   work the same way?").

## Evidence

- Claude Code keeps one memory folder per project directory. Every Claude session in that
  directory shares it: the overseer, its agents and the user's own threads. Its index loads
  into every session at start.
- In one project, the rollout import asked the overseer to read its memory files. Of 29 notes
  that name the session that wrote them, 19 came from the user's own threads, 7 from the
  overseer and 2 from its agents. The overseer imported the threads' items as its own work.
  None came from another project: the bleed is inside a project.
- Today the Claude overseer may write anywhere under `~/.claude`, which includes the memory
  folder of every other project (`coordinator-policy.ts`, `COORDINATOR_MEMORY_REL_DIR`). The
  Codex overseer already has its own folder, `~/.codex/dispatch-coordinator`.

## Checks

1. **A per-process memory folder for Claude: verified.** On 2026-10-07, a throwaway project
   had the token `OTTER-9932` in its normal memory folder and `ZEBRA-4471` in a separate
   folder. `claude -p --settings '{"autoMemoryDirectory":"<folder>"}'` loaded only the
   separate folder, reported it as its memory folder, and did not load the normal one.
   Without the setting, the normal folder loaded.
2. **Can a Codex overseer read a file in the Claude memory folder? Not checked.** The design
   below works either way (Unit 3).
3. **Where Claude keeps a project's shared memory: confirmed in Claude Code's documentation**
   (memory page, "Storage location"): "The `<project>` path is derived from the git repository,
   so all worktrees and subdirectories within the same repo share one auto memory directory.
   Outside a git repo, the project root is used instead." The worktree folders on the user's
   machine under `~/.claude/projects` have no memory folder of their own, which agrees. (Added
   after code review.)

## Design

### Unit 1 — The Claude overseer's own memory folder

- **Folder:** `~/.claude/dispatch-overseer/<encoded project dir>/memory`, encoded the same way
  as Claude's own project folders. One folder per project, so a "New session" overseer in the
  same project keeps the same memory.
- **Start:** every Claude overseer start (spawn and resume) passes
  `--settings '{"autoMemoryDirectory":"<that folder>"}'`. The daemon creates the folder when it
  is missing. The value is a path, not a secret.
- **One-time copy:** when the folder is empty at a start, the daemon copies every note from the
  project's shared memory folder whose `originSessionId` belongs to an overseer of this project
  (the current one or an archived one), and the matching lines of the shared `MEMORY.md` index.
  The shared copies stay where they are. Nothing is deleted.
- **The shared folder follows the git repository** (Check 3): the daemon finds the main root of
  the repository that holds the working directory, so a subfolder or a worktree gives the same
  shared folder as the main checkout. Outside a git repository, it uses the working directory.
  Both paths are resolved through symlinks first.
- **Safety and limits** (added after code review):
  - The resolved own folder must stay inside `~/.claude/dispatch-overseer`, and the resolved
    shared folder inside `~/.claude/projects`. If a symlink leads elsewhere, the daemon skips
    the setup and the copy, leaves that folder out of the write scope, and logs it.
  - The copy can resume: the marker that ends it is written only after every note was handled
    without an error. A later start copies only the notes that are still missing, and never
    overwrites a file.
  - The copy reads at most the first 8 KB of a note to find its origin, skips notes larger than
    1 MB, and handles at most 500 notes per start.
  - If an overseer starts without the home folder configured, the daemon logs it, because that
    overseer has no separate memory.
  - Added after review round 2:
    - If git cannot answer (a timeout, an unreadable folder, an error), or the repository has an
      unusual layout (a git folder not named `.git`, such as a bare repository), the daemon
      treats the shared folder as unknown: it skips the copy, does not end it, leaves the shared
      folder out of the write scope, logs it, and tries again at the next start. Only a clear
      "not a repository" answer falls back to the working directory. Paths keep every character.
    - Both checks are anchored at the resolved `~/.claude`; `dispatch-overseer` and `projects`
      must not be symlinks themselves. A relocated `~/.claude` stays allowed.
    - A resume position is trusted only when it names an entry that exists in the shared folder
      exactly; otherwise the copy starts again from the beginning.
    - A start copies at most 16 MB of notes and reads at most 256 KB of each `MEMORY.md` index.

### Unit 2 — Write scope

| Overseer | May write to | Today |
|---|---|---|
| Claude | its own folder (Unit 1), and this project's shared memory folder | anywhere under `~/.claude` |
| Codex | `~/.codex/dispatch-coordinator` (as today), and this project's shared Claude memory folder | its own folder only |

Every other path stays refused by the coordinator policy, which takes a list of folders
instead of one. The policy covers the file-writing tools. It does not cover a shell command
that writes a file, the same as before this change (see Known limits).

### Unit 3 — The persona

The overseer instructions gain one paragraph (both harnesses; the Codex variant keeps its own
folder label, derived as today):

- **Your memory** is your own folder. It loads at each start. (The Codex variant says "Read it
  at each start.", because Codex does not load the folder by itself.)
- **The project's shared memory folder** holds notes from the user's own threads, and older
  notes of yours. It does not load by itself. Read it when the user asks, or when a task names
  or clearly overlaps one of the user's threads. `read_thread` shows a thread's full history.
  If you cannot read the folder, use `read_thread` and ask the user.
- **Keep the origin.** Something you take from a thread is the thread's, not yours and not the
  user's decision. Name the thread when you use it. A ledger item from a thread needs the
  source kind `thread` (Unit 4), and goes into the ledger only when the user says so.
- **Write a shared note only when the user's threads must know something,** such as a decision
  they must respect or a fact about the project. Start it with "From the overseer:". One fact
  per note.

### Unit 4 — Ledger sources

- **New source kind `thread`:** `ref` is a thread of this project that is neither an agent nor
  the overseer, by label or ID. The daemon checks it. The card renders
  `Source: your thread "<label>"`.
- **`agent` means an agent:** an `agent` source must be a thread with the agent role. One of
  the user's own threads is refused there, with the existing text
  `The source does not exist in this project: <ref>.`
- **The overseer cannot decide a thread's item itself:** `ledger_decide_self` refuses a
  `thread` source with the existing text `Only the user can decide this item.` (Added after
  code review.)

### Unit 5 — Project rules as one line

- In the recap text, `ledger_list` shows `Project rules: 13 in force (type "show rules").`
  instead of the full list.
- `ledger_list` also returns the full list in a separate `rules` field, for the overseer's own
  use. The persona tells the overseer to apply those rules and not to paste them.
- `ledger_show({ rules: true })` prints the full list when the user types "show rules".

## Known limits

- The overseer decides when a task "overlaps" a thread. The rule is in the persona; the daemon
  cannot check it.
- The user's Claude threads still load the shared folder, including notes the overseer writes
  there on purpose. That is the intended bridge.
- The user's Codex threads have no shared project memory, so a shared note reaches only the
  user's Claude threads.
- Check 2 is open. If a Codex overseer cannot read the Claude folder, it relies on
  `read_thread`.
- The write scope covers file-writing tools only. A Claude overseer can still write a file with
  a shell command, as before this change. Per the guardrail policy ("drift, not an adversary"),
  this is documented, not fixed: the persona forbids repository writes, and the policy blocks
  the ship commands.
- The git lookup (at most 2 seconds) and the copy run on the daemon's start path for an
  overseer, not in the background. The caps above bound the copy; moving the work off the
  start path is left for later.

## Tests

- **Spawn:** a Claude overseer start passes `--settings` with its folder, on spawn and on resume;
  a plain thread and an agent do not get it; the folder is created.
- **One-time copy:** only notes whose `originSessionId` is an overseer of this project are copied,
  with their index lines; a second start copies nothing; the shared files stay.
- **Policy:** Claude: writes to its own folder and to the project's shared folder pass; another
  project's memory folder and the rest of `~/.claude` are refused. Codex: its folder and the
  shared folder pass; the rest is refused.
- **Ledger:** a `thread` source of this project passes and renders; another project's thread, an
  agent and the overseer are refused as `thread`; a user thread is refused as `agent`.
- **Rules:** the recap shows the one-line form; the `rules` field and `show rules` carry the full
  list.
- **Persona:** the new paragraph for both harnesses; the six Codex marker strings stay.

## Rollout

1. The usual path: build from this spec, review, PR, then the user's approval for the merge,
   the release and the deploy.
2. After the deploy, each Claude overseer restarts with its own folder and its copied notes. No
   new session is needed.
3. Optional: ask each overseer once to withdraw ledger items that came from the user's threads
   by mistake, or to re-source them as `thread` with the user's go.
