# Task 1 Report — update-force

**Status:** DONE

**Commit:** 6256860 — feat(update): report dirty files and allow forced updates

**Tests:** RED confirmed first (9 new assertions failing: `parsePorcelain` undefined,
`forceable`/`dirty` missing); implemented; `apply.test.ts` (11) + `update.test.ts` (8)
GREEN; full core suite GREEN (787 tests, 96 files); `npx tsc -b` clean.

**Files:**
- `packages/core/src/update/apply.ts` — `parsePorcelain` (exported, 50-cap + overflow
  count), `PreflightResult` gains `dirty`/`dirtyOverflow`/`forceable`, `preflightUpdate`
  takes `opts?: { force?: boolean }`. The dirty-tree early-return is the ONLY branch
  gated on `!opts?.force`; fetch/branch-resolution/ancestor-check code is untouched and
  unconditional below it.
- `packages/core/src/routes/update.ts` — apply handler reads `force` from
  `req.body?.force === true`, passes `{ force }` to `preflightUpdate`, and the
  hand-picked 409 body gains `dirty`/`dirtyOverflow`/`forceable` alongside existing
  `ok`/`reason`.
- Tests extended in `packages/core/src/update/apply.test.ts` and
  `packages/core/src/routes/update.test.ts` (note: these are the actual colocated test
  files — the plan's `packages/core/tests/...` paths don't exist in this repo; also
  added `express.json()` to the route test's `app()` helper so `.send({force:true})`
  bodies parse).

**Concerns:** None. No stashing added anywhere. Wire compatibility preserved (existing
success/409 fields unchanged; new fields additive and `undefined` when not applicable,
which JSON-serializes to simply omitted).

**Self-review:**
- Force-skips-ff-check path: does not exist. The `force` flag only appears in one
  condition (`status.trim().length > 0 && !opts?.force`); fetch/rev-parse/merge-base
  calls are unconditional past that point, same code as before. Verified via a test
  where `force: true` + dirty tree + diverging merge-base still returns `ok:false,
  forceable:falsy` and never reaches `applyFn`.
- Untracked-only tree (`?? scratch.txt\n?? notes.md\n`) parses correctly — covered by
  a dedicated test, passes.

Report path: `/Users/davidwebber/Sites/dispatch/.claude/worktrees/update-force/.superpowers/task-1-report.md`
