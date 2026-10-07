# Overseer memory scope — design

Date: 2026-10-07. **DRAFT — in review by the user, not approved.** Thread "Opus 5.5
Xhigh Handle Business". Follows the decision cards spec
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

### Unit 2 — Write scope

| Overseer | May write to | Today |
|---|---|---|
| Claude | its own folder (Unit 1), and this project's shared memory folder | anywhere under `~/.claude` |
| Codex | `~/.codex/dispatch-coordinator` (as today), and this project's shared Claude memory folder | its own folder only |

Every other path stays refused by the coordinator policy, which takes a list of folders
instead of one.

### Unit 3 — The persona

The overseer instructions gain one paragraph (both harnesses; the Codex variant keeps its own
folder label, derived as today):

- **Your memory** is your own folder. It loads at each start.
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
