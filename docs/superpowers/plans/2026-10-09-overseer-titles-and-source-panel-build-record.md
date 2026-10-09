# Overseer ledger titles and the source panel — build record

Spec: `docs/superpowers/specs/2026-10-09-overseer-titles-and-source-panel-design.md` (approved
2026-10-09). Branch `feat/overseer-titles-source-panel`, based on `main` at `d99d943`. Built with
TDD from the spec, with no implementation plan: for each unit the tests came first and failed for
the right reason. This file records what the spec left open.

## Commits

| Commit | Unit |
|---|---|
| `923953d` | Unit 1: the title field and its rules |
| `f18832c` | Unit 2: the title in the tools, and `ledger_set_title` |
| `948d46c` | Unit 3: the title in the overseer's text |
| `c61bf6e` | Unit 4: the persona |
| `1d8810a` | Unit 5: the title and the PR link in the card data |
| `ce33b20` | Unit 6: the section finder |
| `acf4299` | Unit 7: the source file |
| `ed34bc4` | Unit 8: `GET …/ledger/:itemId/source` |
| `80590b6` | Unit 9: titles on the card and in the chips |
| `a7b517a` | Unit 10: source links and the section panel |

## Decisions where the spec was silent

Core (Units 1 to 8):

- **Title rules.** The length counts characters after a trim. A word is a run without white space
  that holds a letter or a digit; punctuation at its ends does not count. "Only a code" means every
  word is an N-number, a plan code (1 to 6 capitals, an optional hyphen, digits) or a bare number
  such as "#26". Each refusal is a 422 with a fixed text that ends "Fix it and try again."
- **Where the check runs.** `ledger_add` checks the title before the card fields, so a call that
  lacks both gets the title error first. `ledger_add_from_agent` always requires a title (also when
  the item has one already) and stores it at triage. `ledger_decide_self` and `ledger_note` take no
  title. `ledger_set_title` works on any item of the project, of any kind and status; a missing
  title is a 400 "title is required", a bad one a 422.
- **A title change keeps `updated_at`.** The "decided since the last recap" rule and the card's
  "last change" time read it, and a new label must not bring an old answer back into the recap. The
  change still fires `ledger:changed`, so the web reloads the card.
- The test card fixtures (`GO_CARD`, `DECIDE_CARD`) carry a title; a test that checks a title sets
  its own after the spread.
- **"Open items without a title"** closes the own-use text of `ledger_list`, only when there is one.
  Each line holds the question on one line, cut at about 150 characters as in the paste block. The
  tool description of `ledger_list` names the list.
- **Paste lines** keep today's separators: `- N80 · Go · Merge board PR #26 · Your answer: "…"`. The
  New lines keep `· Rec: …`. The `ledger_add` line keeps "— the full card is on the pinned card."
- **The `ledger_show` card** with a title starts `**N17 · Decide · title**`, then the question as
  its own paragraph. The other one-line forms (the Needs-you lines, the defaults lines, the action
  and parked items, the hand-off block) keep the question: the spec does not list them.
- **Persona.** The DECISION CARDS line said "Use the N-ID with its question"; it now says "with its
  title, or its question when it has no title", to agree with LEDGER NUMBERS, and the title joins
  the required fields. The "Before you post a recap" line ends the REPORTING rule.
- **GitHub remotes.** Also accepted: `ssh://git@github.com/owner/repo`, an HTTPS remote with a user
  part, and a trailing slash. git has a 3 second timeout. A null result is cached too. The cache is
  per project folder and per `LedgerService`; git runs only for a ledger with a PR or issue source.
- **Section finder.** The section's markdown starts after the heading line (the panel shows the
  heading on its own), without leading blank lines or trailing white space. The 64 KB limit counts
  UTF-8 bytes; a section with no line end in its first 64 KB is cut at the limit. A heading with no
  text ends a section but is not matched or listed. "No stored section: the outline" is read as
  written, also for an item with an ID. For two headings with the same text, `?heading=` selects
  the first.
- **Source file.** An agent source has a file only for an agent-block item (`agent_terminal_id`
  set), as the card already splits it. The worktree fallback runs whenever the file under
  `.claude/worktrees/` is missing, also when the worktree folder is still there. A folder gives
  "file-only" with "This source is a folder, not a file."; a pipe or a device gives "file-only" and
  is never read.
- **Route errors.** A path or a symlink that leads out of the project is a 403 "The file is outside
  the project" (the spec lists no answer for it; the files route uses 403 for the same case). An
  unknown project and a malformed item ID are a 404 "No such item". The answer type `LedgerSource`
  lives in `ledger-card-types.ts`, which the web imports.

Web (Units 9 and 10):

- **The full card.** The row above keeps the number and the kind; the bold headline is the title,
  with the question below it in regular weight. A short row with a title shows the question on
  hover. The chip popover reads "N40 · title", then the question, the status and the answer. The
  chip index changes when a title changes.
- **The Source button** shows the same short text as before and keeps the full path on hover.
- **The panel.** "Open the full file" sits in the panel's header for every answer kind and keeps
  the panel open. Desktop has the close button and no Back; the phone sheet has Back and no close
  button; Escape works on both. An error shows the route's own text (for example "The file is
  gone") after "Could not load the section", with Retry. The outline starts with "No heading matched
  this item. The headings of the file:".
- **The marked row.** The first table row whose first cell starts with the source ID (a whole word,
  any case), else the first paragraph, list item, row, heading, quote, code block or definition
  that holds it. The mark is a data attribute, tinted yellow in `tokens.css`, scrolled to the
  center.
- The panel's state (`sourcePanel`) lives in `stores/ledgerCard.ts`, next to `focus` and `popover`.

## Points in the spec read loosely

- The spec's Decided example writes "title. Your answer: …"; the build keeps today's " · ".
- With `?heading=` text only, the outline cannot open the second of two headings with the same
  text. A heading index would fix it.
- `ledger_list({ forRecap: true })` marks the recap when it is called. Titles that the overseer sets
  after that call show from the next recap on. The first recap after the deploy can show questions
  for older live items; imported items never show in its New or Decided lines.

## Tests

- Core: 247 files passed, 1 skipped; 2772 tests passed, 4 skipped (main: 240 files, 2693 tests).
  `tsc --noEmit` clean.
- Web: 160 files, 1381 tests passed (main: 158 files, 1356 tests). `tsc --noEmit` clean.
- `pnpm build` from the worktree root passes.
- New test files: core `ledger-title`, `ledger-title-text`, `github-link`, `section-finder`,
  `source-file`, `routes/ledger-source`, `prompts.titles`; web `LedgerTitles`, `LedgerSourcePanel`.
  Path and symlink tests work in a nested temporary folder.
- The route-test flake showed 3 times in 10 full core runs, each in a route test: `terminals` ("socket
  hang up"), `ledger` (the card "only reads" test, message not kept) and `appearance` ("read
  ECONNRESET"). Each file passed 3 of 3 alone, and the next full run was green.

## Left for the next steps

- The checks before the PR: the built code on a copy of the real data, and a test daemon on another
  port. Then the reviews, the PR, and the user's own yes for the merge.
