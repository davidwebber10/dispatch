# Task 2 Report — update modal lists dirty files and offers "Update anyway"

**Status:** Complete, GREEN, committed.

**Commit:** `f2a114a` — `feat(web): update modal lists dirty files and offers a forced update`

## Files changed
- `packages/web/src/api/client.ts` — `applyUpdate(force?: boolean)` now POSTs a JSON body (`{force: true}` or `{}`) and returns the widened type `{ ok, reason?, dirty?, dirtyOverflow?, forceable? }`.
- `packages/web/src/components/update/useApplyUpdate.ts` — `apply(force?: boolean)`; added `failDirty`, `failDirtyOverflow`, `canForce` state, all cleared at the start of every `apply()` call exactly alongside `failReason`. Return shape is additive: `{ apply, applying, failReason, failDirty, failDirtyOverflow, canForce, inProgress }`.
- `packages/web/src/components/update/UpdateModal.tsx` — under the existing failure message: a monospace `{status} {path}` list (max-height ~8 rows, `overflowY: auto`), a `+N more` line when `dirtyOverflow > 0`, and — only when `canForce` — a secondary "Update anyway" button reusing the modal's existing `ghost` button style, wired to `apply(true)`, disabled while `applying`.
- `packages/web/src/components/update/UpdateModal.test.tsx` — extended with 3 new tests (dirty list + overflow + button render; click calls `applyUpdate(true)`; no button when `forceable` absent) and updated the `api.applyUpdate` mock to forward the `force` arg.

## Other call site checked
`packages/web/src/components/settings/UpdatesSection.tsx` (Settings → Updates) uses only `apply`, `applying`, `failReason`, `inProgress` from the shared hook — untouched, compiles and behaves identically since the new fields are additive.

## Test summary
- `npx vitest run src/components/update/UpdateModal.test.tsx` → RED first (2 of the 3 new-behavior tests failed as expected), then GREEN after implementation: 10/10 passed.
- Full web suite: `npx vitest run` → 83 test files, 496 tests, all passed.
- `npx tsc -b --noEmit` → clean, no output.

## Concerns
- None blocking. Pre-existing React `act(...)` warnings appeared in the full-suite run (BrandSwitcher/UpdateModal, unrelated to this change, present before it).
- Did not touch anything under `packages/core`; only read `apply.ts` to confirm field names (`dirty`, `dirtyOverflow`, `forceable`).
- No lifecycle commands, real updates, or live daemon calls were made — tests only, per the safety constraint.
