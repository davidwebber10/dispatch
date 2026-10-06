# Overseer decision cards — build record

Spec: `docs/superpowers/specs/2026-10-06-overseer-decision-cards-design.md` (approved 2026-10-06).
Branch `feat/overseer-decision-cards`, stacked on `feat/overseer-structured-recap` (PR #62).
Built with TDD from the spec, with no implementation plan. This file records what the spec left open.

## Commits

| Commit | Unit |
|---|---|
| `fa1e2d3` | Unit 1: card fields, migration 006 |
| `d44847c` | Unit 2: card checks in the daemon |
| `9e73620` | Unit 5: the card and the recap sections (built before Units 3 and 4, which use it) |
| `d6c21b9` | Unit 3: capture from agent reports |
| `e50fef4` | Unit 4: triage and card tools (MCP 22 → 26) |
| `5a25784` | Unit 6: the Batch line sentence |
| `6ac1ea2` | Unit 7: persona changes |

## Decisions where the spec was silent

Data:
- Two more columns: `sent_at` (when the item reached the user) and `decided_at` (when the overseer decided it). The "new since the last recap", "oldest", "already sent to the user" and 7-day count rules need them. Migration 006 sets `sent_at = created_at` on every #62 row.
- Options are stored as `{ label, effect }`. A #62 row with plain strings reads back as labels with an empty effect.
- Tool field names follow the agent block: `context`, `options`, `recommendation`, `why`, `default`, `source { kind, ref, section, id }`, `note`.

Checks (Unit 2):
- The missing-field list names each field with its rule, for example `context (20 to 800 characters)`. A field with a wrong value counts as missing, with the same fixed text.
- Imported `go` and `decide` items need the card fields whatever their status (spec rollout step 3). A 422 from import carries `item: <index>` in the body.
- Import refuses `policy` (400): an imported statement has no checked quote, so it cannot be a project rule.
- A plan-style ID is 1 to 3 capital letters, an optional hyphen, and 1 to 3 digits. Range separators: `..`, `...`, `…`, `-`, `–`, `—`, `to`, `through`, `thru`. Three or more distinct IDs fail. Known false positives: `Q3-Q4`, and three short product names such as `S3, EC2 and R2`. Changed in review round 1.
- A plan or doc path may be relative, or absolute inside the project. A `..` escape, an absolute path outside, and a symlink that leads outside all fail. The stored path is relative. Git worktrees come from `git worktree list --porcelain` (injectable in tests). Changed in review round 1: an absolute path fails.
- A `user` source keeps the user's words in `ref`, checked as `ledger_note` checks them; its failures use the #62 quote texts.
- An `agent` source matches the label or the ID of any agent of the project, archived ones included, and stores the label.

Capture (Unit 3):
- "The final message" is the newest assistant text of the last turn. If it has no block, the earlier texts of the same turn are read too, up to the previous `result`. Reason: agents call `report_status` last and can write a short line after it. Changed in review round 1: the texts come from the harness.
- The last `owner-decisions` fence in a message wins. The closing fence must be on its own line. Changed in review round 1: the last top-level fence.
- An entry without `kind` is a `decide`. Only `decide` and `go` are accepted.
- An agent-block item stores the agent's label in `source_ref`, `path#section` in `source_section` (`#section` when there is no path), and the entry's `id` in `source_id`. The card writes "plan" when the path contains "plan", else "doc". This gives the spec's example line exactly.
- A changed question after triage creates a new proposed item with no `supersedes` link; the triaged item keeps its status.
- An invalid entry adds `Skipped owner decision <id>: <failed check>` to the notice. An entry with no `id` is named by its position, `#3`.
- The ID list in the count line: one ID, two IDs with a comma, `N30 to N36` for a run of three or more, else a comma list.
- Only the Finished notice reads the block (not Blocked), for every agent type, never for role runs. A capture failure never drops the notice.

Rendering (Unit 5):
- `ledger_add` returns the full card as `line` for `go` and `decide`, so the #62 rule "post the line as is" now posts the card.
- Section headings keep the #62 form (`Needs you now:`). The new sections always show, with `- none` when empty, except Project rules (spec: only when rules exist). The count line always shows.
- Needs you now: cards for new items in ID order, then the top 5 (holds up work first, then oldest sent), then one-liners in the same order. With no recap yet, every open decision is new. Items running on their default leave this section but stay open.
- The count line counts overseer decisions decided in the last 7 days, and the reversals among them.
- The card meta line shows `Holds up: nothing` when unset, and `Open 3 hours` (minutes, hours, days) from `sent_at`. Other statuses show a status word. Imported and on-default items add a part. A closed item ends with an `Outcome` paragraph instead of the answer line.
- The answer line: a decide card uses the short label of the recommendation (`A` from `A. 5 nights`); a decide card with no options says `` `N4:` and your own words``; a go card uses the first action word in the question, else `approve` (the ID passes the #62 named-approval rule).
- An old #62 row renders as a card without the missing fields, with `**Recommended:** …` when there is no reason.

Tools (Unit 4):
- `ledger_decide_self` works only on proposed items: every other path sends the item to the user when it is created. Error order: 404, 422 (rule 4), 409, 400. Changed in review round 1: without `id`, it creates an item that is already decided.
- A reversal needs a quote from after `decided_at`. Only `answered` reverses; parking or withdrawing an overseer decision is a 409. A proposed item can be resolved like an open one.
- `ledger_mark_default` takes open `go` and `decide` items only, and keeps the first start date.
- `ledger_show` takes `ids` (a list or one string) or `all: true` (open `go` and `decide` items, on-default ones included). A `do` item shows its #62 line. No open decision gives `No open decisions.`
- Role runs: the new tools are denied by the role policy allowlist, as the #62 ledger tools are.

Batch line and persona (Units 6 and 7):
- `Not yet triaged: …` is its own line after `Open ledger items: …`.
- The recap list keeps the #62 contract lines and adds one sentence for the new parts. Full cards do not count toward the 25-line limit, because a single card is about 15 lines.

## Deviations and known gaps

- Spec "final message" is widened to the final turn's texts (see above). The test pins that the full text is read, not the 600-character summary.
- Two texts that the spec does not fix: the skipped-entry line and the import `policy` refusal.
- The overseer cannot record a low-level decision that did not come from an agent block: `ledger_add` sends at once, and rule 4 then refuses `ledger_decide_self`. This follows the spec's rules. Fixed in review round 1.
- `importItems` parses `options` twice (once in the card check). Harmless; left as it is to keep one commit per unit.

## Review round 1

Findings from a code review and a second-model review. Each fix has a test that failed first.

1. **Codex agents' blocks were missed (High).** A Codex agent streams its prose as deltas, so the ring has no whole text, and on a resumed thread it holds old backfilled text. New: `IStructuredManager.getTurnTexts(terminalId)`, the complete texts of the last ended turn, oldest first, from each harness: Claude from the whole `assistant` messages in its ring (`turnTextsFromEvents`), Codex from each completed `agentMessage` item, Grok and OpenCode from each closed prose block. The capture reads only this, newest first, so the text written after `report_status` still counts. Test: the real Codex manager and translator, driven by the fake app server (new `report-file` trigger), and the captured Codex frames.
2. **The overseer could not record its own low-level decision (High).** `ledger_decide_self` without `id` creates a new item that is already decided: always `decide`, the same card checks as `ledger_add`, `sent_at` NULL, `decided_at` now, the choice and the reason. New route `POST /sessions/:id/ledger/decide-self` (201). The MCP schema, the tool description and the persona teach it. With `id`, nothing changes.
3. **The one-decision check (Medium).** IDs now have 1 to 6 letters and 1 to 5 digits (`PLAN-1`, `D1000`), and the range words match in any case (`D1 TO D9`). A range needs the same prefix at both ends (or a bare number), and "from X to Y" is a change, not a range. A list fails only with 3 or more IDs of one prefix. A code comment states the known limits.
4. **A quoted example became a real decision (Medium).** The parser scans from the top and tracks open fences as CommonMark does. A fence inside another fence, or indented 4 or more spaces, is content. The last top-level block wins.
5. **No size limits (Medium).** A block over 64 KB (UTF-8 bytes) or with more than 50 entries is a broken block, with the reason in the notice line. Nothing changes.
6. **"Running on defaults" dropped the import label (Medium).** It now ends with `Imported, not checked.` as the Needs-you-now line does.
7. **Malformed `go` options gave a 400 (Low).** Omitted (none, `null`, `[]`) and malformed (any other value) are now different: malformed is the 422 card text.
8. **Absolute source paths (Low).** A `plan` or `doc` source with an absolute path fails before the lookup, with the "does not exist" text.
9. **`blocks` from an agent entry (Low).** The capture ignores it. `ledger_add_from_agent` takes an optional `blocks`.
10. **A reversal read "You approved" (Low).** It now reads `You reversed the overseer's choice "<choice>": "<quote>" (<time>)`.
11. **Sub-agent texts (Low).** `turnTextsFromEvents` skips events with a `parent_tool_use_id`. Codex and Grok sub-agents run on other threads, so their texts never reach the translator of the agent.
12. **Test gaps.** The reversal test has a user message between `created_at` and `decided_at` (a mutation to `createdAt` now fails it). A test pins that an agent entry cannot set `author`, `status`, `policy`, `supersedes`, `sent_at` or `origin`.

Decisions in this round:
- `getTurnTexts` is a required member of `IStructuredManager`, so a new harness cannot leave it out. The nine test fakes that implement the interface return `null`.
- The contract is "the last ended turn" for every harness. The capture runs at the turn end, so this is the same turn.
- `ledger_decide_self` without `id` refuses `kind: "go"` with "Only the user can decide this item." (rule 4), instead of turning it into a `decide` item. Any other `kind` becomes `decide`.
- Known limits of the one-decision check: "Approve from D1 to D9?" passes; "Upgrade the API V1 to V2?", "Q3-Q4" and "GPT-4, GPT-5 or GPT-6" fail.

## Test counts (final)

- Core: 226 files passed, 1 skipped; 2488 tests passed, 4 skipped (baseline before this work: 2379).
- Web: 150 files, 1284 tests passed. No web change was needed.
- Typecheck: `packages/core` and `packages/web` clean.
- One full core run had a "socket hang up" in `tests/routes/structured.test.ts` ("a coordinator spawn folds the dispatch agency server into its --mcp-config"). The other full run passed, and the file alone passed 3 of 3 runs. It is the known load flake of that file, in a different case than the Codex one.
- After review round 1: core 226 files passed, 1 skipped; 2516 tests passed, 4 skipped. Web: 150 files, 1284 tests passed (no web change). Both typechecks clean. One of two full core runs had `read ECONNRESET` in `tests/routes/structured.test.ts` ("an agent question escalates UP to the project coordinator"); the file alone passed 3 of 3 runs, and the second full run passed.
