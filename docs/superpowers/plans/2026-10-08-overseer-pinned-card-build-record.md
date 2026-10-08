# Overseer pinned recap card — build record

Spec: `docs/superpowers/specs/2026-10-08-overseer-pinned-card-design.md` (approved 2026-10-08).
Branch `feat/overseer-pinned-card`, based on `main` at v2.45.1 (`79f6102`). Built with TDD from the
spec, with no implementation plan: for each unit the tests came first and failed for the right
reason. This file records what the spec left open.

## Commits

| Commit | Unit |
|---|---|
| `f5ab35e` | Unit 1: `ledgerSections`, the recap sections as data |
| `97034ea` | Unit 2: `GET /api/sessions/:sessionId/ledger/card` |
| `f826ca8` | Unit 3: the `ledger:changed` event |
| `b39b892` | Unit 4: the interim recap only for something new |
| `5fe691c` | Unit 5: the recap paste block and the persona |
| `049b5c8` | Unit 6: the web data hook |
| `107b985` | Unit 7: the card |
| `48ca42c` | Unit 8: clicks fill the message box |
| `a4a301c` | Unit 9: ledger chips in the chat |

## Decisions where the spec was silent

Core (Units 1 to 5):
- One rule decides "new" everywhere: `isNewForUser` (open, not imported, sent after the last
  recap; every open item when there is no recap yet). Units 1, 4 and 5 use it, for `go`, `decide`
  and `do` items. The full cards of "Needs you now" still take only `go` and `decide` items that
  do not run on a default, so the text of `renderLedgerSections` is unchanged.
- `decidedSince` is one list: the user's answers and the withdrawals first, then the overseer's
  own decisions. `counts` is `{ overseerDecisions, reversed }`.
- The card JSON adds `author` (for "Not yet triaged … from" an agent) and `reading` to the fields
  the spec lists. The source has a `path` field: an agent-block item stores the file and the
  section in one column, and the card splits them. `newSeqs` is not in the JSON; each item
  carries `isNew`.
- `updatedAt` is the newest change of any item of the project (null for an empty ledger), not
  the time of the request.
- `lastRecapAt` comes from the project's live (not archived) overseer. With none, it is null.
- `answerKey` follows the spec: one to three letters or digits and a full stop, then a space or
  the end ("1.5 nights" is a whole label). The chat card's "Answer with" line keeps its own,
  wider rule (it also takes ")" and ":"); only odd labels differ.
- The card payload types live in `overseer/ledger-card-types.ts`, a core file with no imports
  that the web re-exports, as the Control Plane analytics types do. Its unions repeat those of
  `db/ledger.ts`; the builder assigns one to the other, so a new value fails the build.
- The owner-decisions capture calls `onChange` only when it created an item. `wireLedger` in
  `server.ts` wires both `LedgerService` instances; a source test pins that both app builders use
  it. The web does not coalesce events: each `ledger:changed` is one GET.
- The interim notice names the count: "2 new items wait on the user, and 2 agents still work.
  Post the short recap now …". The Stream pill detection is unchanged.
- `ledger_list` returns the two parts with and without `forRecap`; only `forRecap` stamps. The
  route returns `paste` next to `text`, `openIds` and `rules`; the dispatch MCP adds the two
  headings. The project rules in full go in the own-use block, under their existing heading.
- The paste block: "New:" and "Decided:" groups with "- " lines (markdown would join bare lines
  into one paragraph), blank lines between the groups, a group with no lines left out, and the
  count line always last. "Decisions" in the count line are the open decisions of "Needs you
  now"; items on a default are not counted. A statement reads `N1 · You said: "…"`.
- `ledger_add` returns the one line for every kind, `do` included.
- Persona: the TRIAGE bullet and the `ledger_add_from_agent` description still say the user sees
  a triaged item "in the next recap"; that stays true (the New lines). The daemon's Batch footer
  ("add it with ledger_add and post only that item") is unchanged: with the one-line result it
  still reads right.

Web (Units 6 to 9):
- The card loads from `useCoordinatorSync` (the Control Plane root), not from the card, so the
  collapsed-pane count and the chips have it while the card is not mounted. A response older
  than the newest request for that project is dropped.
- The folded sections are folded by default; the open ones are kept in local storage
  (`dispatch:ledgerCard:open`), the same for every project. The rules list is one more fold.
- "Nothing needs you." shows when there is no open decision and no action. The context is cut
  with a CSS three-line clamp; "more" shows past 180 characters (jsdom has no layout to measure).
- A line or a section row opens as a full card in place, with a "fold" link back. Only an open
  item takes a click on an option.
- The "open decision count" (the collapsed right toggle, the mobile Work tab) is the number of
  open decisions under "Needs you now". The toggle shows it only on the Control Plane tab.
- The draft: the composer's draft already lives in `useDraft` local storage per project. The
  store action `addToDraft` appends there (`appendToStoredDraft`, which trims trailing white space
  before ", ") and fires a window event that a mounted `useDraft` reads. So the append lands
  whether the composer is mounted or not, and is never applied twice. The hint is per project,
  cleared on send; the composer takes the focus once per click.
- Chips: also in the quote of the direct-message notice card. Never inside `code`, `pre` or a link.
  The label cuts at a word in the last 20 of the 70 characters. A chip opens with Enter or Space
  too; a chip inside a clickable notice pill keeps the click to itself. The popover closes on
  Escape or a click outside. The chip index is the shown project's card only.

## Deviations

None from the spec's behavior. Two existing pins changed on purpose, as the spec says: the
`ledger_add` result (one line, not the full card) and the recap format in the persona tests.

## Tests

- Core: 237 files passed, 1 skipped; 2674 tests passed, 4 skipped. `tsc --noEmit` clean.
- Web: 158 files, 1337 tests passed. `tsc -b` clean.
- `pnpm build` from the worktree root passes.
- New test files: core `ledger-sections`, `ledger-card`, `ledger-change`, `ledger-paste`,
  `prompts.pinned-card`; web `stores/ledgerCard`, `ledger`, `LedgerCard`, `LedgerCardPlacement`,
  `PanelToggle`, `store-draft`, `lib/ledgerRefs`, `LedgerChips`. Fixtures copy the shape of real
  rows with generic text.
- Every core run used the suite's own temporary HOME per file. No flake was seen.

## Left for the next steps

- The two code reviews, the run against an isolated daemon with real-shaped data (the route, the
  event on a write, the interim rule, the card in a browser), and the PR, as the spec's "Build and
  review" section orders them. This build started no daemon.
