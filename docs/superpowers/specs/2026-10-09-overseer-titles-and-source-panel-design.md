# Overseer ledger titles and the source panel — design

Date: 2026-10-09. Approved by the user on 2026-10-09, section by section ("yes" four times).
Thread "Opus 5.5 Xhigh Handle Business". Phase 2 of the overseer recap work, items 8 (source
links) and 10 (a short title for each ledger item). Follows
`docs/superpowers/specs/2026-10-08-overseer-pinned-card-design.md` ("Out of scope (later phase 2
work)": "Source links that open a plan at its section" and "A short title field on ledger
items").

Changed after review round 1 and the real-data check (2026-10-09): titles first, once per
recap (Unit 3); a section-number match (Unit 6); a worktree lookup and a note that names the copy
read (Unit 7, Unit 8). Each change is marked "Review round 1" below.

## Goal

Each ledger item gets a short title that the overseer writes. Chips, card rows and recap lines
show the title instead of a question cut at an arbitrary length. A click on a Source line shows
the plan section that the item comes from, on the Control Plane, without the need to open and
search a large file. A PR or an issue source opens on GitHub.

## Decisions

1. **The overseer writes the title, and the daemon requires it on each new decision and
   action** (user: "Q1: A"). At most about 40 characters. Open items that exist get titles once;
   closed items keep their question.
2. **A click on a Source line opens a section panel over the chat** (user: "Q2: C"). The panel
   shows only the section, with the item's row marked, and a button that opens the full file.
   PR sources open GitHub in a new browser tab.
3. **Existing open items get titles automatically, before the next recap** (user: "Q3: A"). The
   user sends nothing.
4. **The title shows everywhere outside the card; the card shows the title and the full
   question** (user: "Q4: A"). Chips and recap lines show only the title. A chip's hover text is
   the full question.
5. **A daemon route returns only the section** (user: "1"). The daemon finds the file and the
   section and adds the GitHub link for PR sources.
6. Design sections 1 to 4 approved (user: "yes", "yes", "yes", "yes").

## Evidence

Ledger data of all projects on one machine, 2026-10-09:

- 176 `go`, `decide` and `do` items. Their questions have 100 characters on average; the longest
  has 947. A chip shows at most 70 characters, so 131 of the 176 chips (74%) are cut. Example:
  "Do you approve the merge of board PR #26 (docs/BOARD.md update for 2026-10-09)?" shows as a
  chip cut after "update for". A title would read "Merge board PR #26".
- Sources: 41 plan sources (all with a path, a section and an ID), 9 doc sources, 25 agent
  sources (12 with a file and a section), 36 PR sources, 21 overseer sources. No thread, issue
  or user sources.
- A plan file behind 41 items has 480 KB. Its stored section name is "Open owner decisions after
  v3", but the heading in the file now reads "Open owner decisions after v3.2 (the v3 table,
  updated 2026-10-08)". A plain jump to an exact heading fails.

## Design

### Unit 1 — the title field and its rules (core)

- A new nullable column `ledger_items.title` (a schema migration). Existing rows keep `NULL`.
- `text` (the question) does not change. Quotes and the answer check still use the question.
- A title must be one line, have at least 2 words and at most 50 characters, and must not be only
  a code (an N-number such as "N41", or a plan code such as "Q12", "LR-6" or "A11"). The persona
  asks for about 40 characters.
- A bad title is refused with 422 and the reason, in the same shape as the other card-field
  errors.

### Unit 2 — the tools (core)

- `ledger_add`: a `title` parameter, required for `go`, `decide` and `do`.
- `ledger_import`: `title` per item, required for an open `go`, `decide` or `do` item; optional
  for answered and parked items and for statements.
- `ledger_add_from_agent`: a `title` parameter, required for a `go`, `decide` or `do` item. The
  agent's text stays word for word.
- Not required: statements (project rules keep the quote and the reading) and
  `ledger_decide_self`.
- A new tool `ledger_set_title({ id, title })` sets or changes the title of an item of the
  overseer's own project (`POST /api/sessions/:sessionId/ledger/:itemId/title`, overseer only,
  like the other ledger write routes). A title is a label, so a change is safe; the persona says
  to set it once and change it only with a reason.

### Unit 3 — the overseer's text (core)

- `ledger_list` "For your own use — do not paste" gains a list "Open items without a title":
  every `go`, `decide` and `do` item with status open or parked and no title, one line each (the
  ID, the kind and the question).
- The paste block uses the title: "New: N41 · Do · *title*", "Decided: N80 · Go · *title*. Your
  answer: …". The count line does not change. An item without a title keeps today's line (the
  question, cut at about 150 characters).
- The one line that `ledger_add` returns is "N41 · Do · *title*".
- The chat cards that `ledger_show` renders show the title in the header and the question below
  it. The overseer's own-use lines show the title before the question, unless the title only
  repeats it.
- Review round 1 — titles first, once per recap: with items that have no title, the first
  `ledger_list({ forRecap: true })` call of a recap answers only "Titles first" and the list, and
  does not mark the recap. The next call is the recap, with or without the titles. Thus the recap is
  never blocked, and its New lines are never spent on a call that the overseer cannot paste.

### Unit 4 — the persona (core, Claude and Codex)

- New line (review round 1): when `ledger_list({ forRecap: true })` answers "Titles first", give
  each listed item a title with `ledger_set_title`, then call it again; otherwise call it once per
  recap.
- The LEDGER NUMBERS rule changes to: every ledger number carries its title, or its question when
  it has no title.
- The tool list names `ledger_set_title` and the `title` parameter, with the title rules.
- Both harnesses get the same lines; the six Codex marker strings stay.

### Unit 5 — the card data (core)

- `CardItem.title` and `index[].title` (string or null) in `ledger-card-types.ts`.
- `CardSource.url` (string or null): for a `pr` or `issue` source, the GitHub link. The daemon
  reads the project's remote (`git remote get-url origin` in the project folder), accepts the
  SSH form (`git@github.com:owner/repo.git`) and the HTTPS form (with or without `.git`), and
  builds `https://github.com/owner/repo/pull/26` or `/issues/26`. A ref that is already a GitHub
  URL is used as is. Any other remote, or a git error, gives `null`. The remote is cached per
  project for 10 minutes.

### Unit 6 — the section finder (core, pure functions)

- Input: the markdown text, the stored section name (may be empty), and the item's ID (may be
  empty). Output: a section (the heading and the markdown from the heading to the next heading of
  the same or a higher level) or an outline (every heading, with its level).
- ATX headings only (`#` to `######`); headings inside fenced code blocks are ignored.
- Normalize for comparison: lower case, markdown emphasis and code marks removed, spaces
  collapsed, end punctuation removed.
- Order of matches: an exact match; then a heading that starts with the stored name (so "after
  v3" finds "after v3.2 (…)"); then a stored name that starts with the heading; then a heading
  that contains the stored name; then a heading that contains the ID as a whole word; then
  (review round 1) a heading with the same leading section number ("9. Owner decisions" finds
  "9. Decisions recorded (…)"; "9" never matches "9.1"). The first heading in the file wins at
  each step.
- A fence can open inside a list item ("- ```md") and close indented (review round 1).
- No match, or no stored section: the outline.
- A section longer than 64 KB is cut at a line end, with the note "The section continues in the
  file."
- A `heading` input (from an outline click) selects that exact heading.

### Unit 7 — the source file (core)

- Plan and doc sources use `source_ref`; agent sources use the path part of the stored
  "path#section" value. Paths are relative to the project folder.
- The real path (symlinks resolved) must stay inside the project folder; worktrees under the
  project folder count as inside. An absolute path is accepted only when it is inside the
  project folder.
- If the file is missing and its path starts with `.claude/worktrees/` plus a worktree name, the
  daemon tries the rest of the path in the project folder and flags `fromMainCheckout`.
- Review round 1: if a project path is missing, the daemon looks for it in each worktree under
  `.claude/worktrees/` (an overseer can store the path an agent saw in its worktree). The newest
  copy wins; a worktree that leads out of the project is skipped.
- Every answer carries `note`, the text that names the copy read when it is not the stored path:
  "From the main checkout: the worktree is gone.", "From the main checkout: the worktree does not
  have this file.", or "From the worktree "name": the main checkout does not have this file."
- "." or the project folder itself is a folder (file-only), not a way out.
- Markdown files only (`.md`, `.markdown`). Other files and files larger than 5 MB give no
  section, only the full-file path.

### Unit 8 — the source route (core)

`GET /api/sessions/:sessionId/ledger/:itemId/source[?heading=…]`, read-only; the network is the
gate, as for the card route. Answers:

- `{ kind: "section", file, path, heading, markdown, id, fromMainCheckout, note, cut }`
- `{ kind: "outline", file, path, headings: [{ level, text }], fromMainCheckout, note }`
- `{ kind: "file-only", file, path, fromMainCheckout, note, reason }` for a folder, a file that is
  not markdown, or a file that is too large.
- 404 "No such item"; 422 "This item has no file source"; 422 "This project has no folder";
  404 "The file is gone"; 403 "The file is outside the project".

### Unit 9 — titles on the card and in the chips (web)

- A full card's headline is "N41 · Do · *title*", with the full question below it. Short rows
  (actions, defaults, decided, parked, not yet triaged, the Needs-you lines) show "N41 · *title*".
- `chipLabel` uses the title when there is one; the chip's hover text is the full question.
- The chip popover shows the title, the question, the status and the answer.
- An item without a title looks as it does today.

### Unit 10 — source links and the panel (web)

- On the card, a plan, doc or agent-with-file Source line becomes a button that opens the panel.
  A PR or issue source with a `url` becomes a link (`target="_blank"`, `rel="noopener
  noreferrer"`). Other sources stay text.
- Desktop: the panel opens over the chat column of the Control Plane. It shows the file name,
  the heading, "From the main checkout: the worktree is gone." when flagged, the section
  (rendered with the app's markdown renderer), "Open the full file" and ✕. After it renders, the
  web marks the first table row whose first cell starts with the item's ID (a whole word), or
  else the first block that contains the ID, and scrolls to it.
- Outline: a list of the headings; a click loads that section (`?heading=`).
- "Open the full file" opens the file tab (`openFileTab`, `focus: true`).
- Escape and ✕ close the panel. A click on another Source line replaces it. A change of project
  closes it.
- Phone: a full-screen sheet over the Work tab, with a back button.
- Loading shows a short placeholder; a network error shows "Could not load the section" and
  Retry.

## Errors and edge cases

- A refused title returns the reason; the overseer fixes it and retries.
- The daemon asks for titles once per recap ("Titles first") and never blocks a recap.
- A source file can change after the decision was recorded; the panel shows the file as it is now.
- Two headings with the same text: the first one wins; the outline lets the user choose.
- Git remote errors give no PR link and no error message.

## Tests

Test first, one commit per unit.

- Core: the title rules; the required cases in `ledger_add`, `ledger_import` and
  `ledger_add_from_agent`; `ledger_set_title` (own project only, overseer only); the "Open items
  without a title" list; paste lines, the `ledger_add` line and the `ledger_show` header with
  and without a title; `CardItem.title` and `index[].title`; the persona lines for both
  harnesses.
- Section finder: exact match, the "after v3" → "after v3.2 (…)" case, an ID in a heading, the
  outline, headings in code blocks, the section end, the 64 KB cut, the `heading` input.
- Source file: a file inside the project, the worktree fallback, refusals for `../`, an absolute
  path outside the project and a symlink that points outside (temporary folders only), the
  markdown and size checks.
- GitHub link: SSH and HTTPS remotes, the `.git` suffix, a URL ref, a remote that is not GitHub,
  a git error.
- Route: each answer and each error.
- Web: chips with titles and the hover question; the card headline and rows; the popover; the
  source button and the PR link; the panel states (section, outline, file-only, error, loading);
  the marked row; Escape and ✕; the project change; the phone sheet.

## Checks before the PR

- Real data: the built code runs on a copy of the real database and the real project folders.
  For each file source, report section, outline, file-only or "The file is gone".
- A test daemon on another port with a temporary home folder: the route, the new tool and the
  title rules over HTTP.
- Reviews: GPT and Fable, at most 2 rounds.

## Known limits

- Setext headings (underlined with `===` or `---`) are not found; the outline does not list them.
- A worktree outside the project folder is not searched; its files give "The file is gone".
- With two headings of the same text, the outline opens only the first one.
- A title change is not logged.
- The panel shows the file at the time of the click, not at the time of the decision.
- Chat decision cards keep a plain-text Source line (no link).

## Out of scope

- A title editor for the user.
- Links for agent sources without a file (to the agent's thread) and for thread sources.
- Remotes that are not on GitHub.
- The rest of phase 2: the cross-project "Needs you" view (with the Board's owner), alerts for
  new decisions, a rules editor, folded overseer replies, buttons that send an answer at once.

## Build and review

Built from this spec with test-driven development and one commit per unit; a short build record
in `docs/superpowers/plans/`. One PR; it stops at "PR open, CI green" for the user's merge
approval.
