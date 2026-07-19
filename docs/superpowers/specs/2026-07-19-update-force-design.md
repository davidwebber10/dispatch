# Dispatch — Show What's Dirty, and Force Update

**Date:** 2026-07-19
**Status:** Approved through implementation.

## Problem

`POST /api/update/apply` refuses whenever `git status --porcelain` is
non-empty, with one flat sentence: "Working tree has uncommitted changes —
commit or stash before updating." It doesn't say *what* is dirty, and
offers no way past. In practice the user has to ask an agent to clean the
tree before every update — even when the dirty files are untracked scratch
files the update would never touch.

Our gate is stricter than git's. `git pull --ff-only` only refuses when the
incoming commits actually touch a file with local modifications; untracked
files and edits to unrelated files fast-forward cleanly. So the fix is to
report the facts and let the user delegate the decision to git.

## Decisions

1. **Show the dirt.** A dirty-tree preflight failure returns the parsed
   porcelain entries so the client can list them.
2. **Force delegates to git**, it does not bulldoze. `force: true` skips
   *our* clean-tree gate only. Everything else still applies, and
   `git pull --ff-only` remains the thing that actually decides — if it
   would clobber a modified file, git refuses and the update fails loudly.
3. **No auto-stash.** The stash stack is shared across this repo's
   worktrees and concurrent sessions; silently stashing could collide with
   another session's entry. Never stash on the user's behalf.
4. **Divergence is not forceable.** A diverged branch genuinely cannot
   fast-forward; `force` does not skip that check.

## API

`PreflightResult` gains two optional fields:

```ts
export interface PreflightResult {
  ok: boolean;
  reason?: string;
  /** Set only on a dirty-tree failure: parsed `git status --porcelain` rows. */
  dirty?: { status: string; path: string }[];
  /** True when the only thing blocking is the dirty tree — i.e. force would proceed. */
  forceable?: boolean;
}
```

`preflightUpdate(repoDir, gitExec?, opts?: { force?: boolean })` — with
`force: true` the dirty-tree branch is skipped entirely (no status parse
needed for the decision, though it still runs for reporting); fetch,
branch resolution, and the ancestor/fast-forward check are unchanged.

`POST /api/update/apply` reads `force` from the JSON body (default false)
and passes it through. Success and 409 shapes are otherwise unchanged, so
an older client keeps working; the 409 body simply carries the extra
fields.

Porcelain parsing: each line is `XY <path>` where `XY` is the two-character
status code (`??` untracked, ` M` modified, `A ` added, etc.). Rename lines
(`R  old -> new`) keep the full remainder as the path. Entries are capped
at 50 with a count of the remainder, so a pathological tree can't produce
a giant response.

## UI

The update banner's failure state (`useApplyUpdate` + its banner) shows the
dirty entries as a short list (status code + path, scrollable past ~8) and,
when `forceable` is true, an **Update anyway** button that re-issues the
apply with `force: true`. When the failure isn't forceable (divergence, git
errors) the button is absent and today's message shows as-is.

## Testing

- `preflightUpdate` unit tests via the existing injectable `gitExec`:
  dirty tree → `ok:false`, `forceable:true`, parsed entries; dirty tree
  with `force:true` → proceeds to the fetch/ancestor checks; diverged →
  `forceable:false` with or without force; untracked-only tree parses
  correctly; the 50-entry cap.
- Route test: `POST /api/update/apply {force:true}` on a dirty tree
  reaches the apply function; without force it 409s carrying `dirty`.
- Web: banner renders the dirty list and the button only when
  `forceable`; clicking re-issues with force.

**Deliberately no live runtime verification:** exercising a real forced
update means actually updating a running daemon from a dirty tree. The
`gitExec` seam exists precisely so this is testable without that.
