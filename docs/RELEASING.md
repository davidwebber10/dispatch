# Cutting a release

How to ship a new version of Dispatch. Written for an agent (or maintainer) working in this
repo. If you only remember one thing, remember this:

> **A release is three things that must move together: a hand-written release note, a
> `package.json` bump, and a git tag + GitHub Release.** `dispatch release` does only the
> tag half, and it now *refuses* if either of the other two is missing.

Cutting a release is **not** the same as deploying. See [What a release does *not* do](#what-a-release-does-not-do).

---

## The mental model — three things that must move together

The auto-updater reads three things:

| Thing | Where it lives | Who reads it | Moved by |
| --- | --- | --- | --- |
| **The tag** | `vX.Y.Z` on GitHub (the newest [Release](https://github.com/davidwebber10/dispatch/releases)) | every install polls `GET /releases` (`packages/core/src/update/checker.ts`) | `dispatch release` |
| **The running version** | `version` in the four `package.json` files | the daemon reads its own `packages/core/package.json` (`getRunningVersion()`, `packages/core/src/update/version.ts`) | a hand-authored `chore(release)` commit |
| **The release note** | `docs/releases/vX.Y.Z.md`, copied into the GitHub Release body | the same poll, then the update prompt shows it | you, before you tag — `dispatch release` refuses without it |

The daemon polls GitHub roughly every 45 minutes and shows the update prompt **only when the
newest release tag is strictly newer than the version it was built from**
(`isNewerVersion(tag, running)`).

So:

- **Tag bumped, `package.json` forgotten** → a freshly-updated install still reports the old
  version and the prompt never clears. It nags forever. (`dispatch release` now catches this.)
- **`package.json` bumped, tag forgotten** → GitHub's newest release stays old and **no
  install is ever notified**.
- **No release note** → nobody can see what the update contains before installing it.
  (`dispatch release` now refuses outright.)

`dispatch release` only ever touches the tag. **You** own the `package.json` bump and the
note, and both have to be committed and pushed to `main` *before* you tag.

---

## How a release note reaches the user

This is the whole path, so you know what your markdown file turns into:

```
docs/releases/v2.11.0.md          you write this, on main, before tagging
        │
        │  dispatch release 2.11.0  →  gh release create --notes-file <that file>
        ▼
GitHub Release body for v2.11.0
        │
        │  each install polls GET /repos/davidwebber10/dispatch/releases (~45 min)
        ▼
checkForUpdateOnce()  →  app_state.latest_release_notes   (packages/core/src/update/checker.ts)
        │
        │  GET /api/state/update  →  { notes: [...], currentNotes }
        ▼
Update prompt  +  Settings → UPDATES        "Release notes" ▸ expands, scrolls
```

Two details worth knowing:

- **Skipped versions are included.** The checker reads the release *list*, not just the
  newest one, and keeps every release newer than the running version (up to 10). An install
  on 2.9.0 that sees 2.12.0 shows the notes for 2.10.0, 2.11.0 and 2.12.0.
- **Settings can also show the note for the version already running.** That one is read
  straight off disk from this checkout (`readLocalReleaseNote()`), not from GitHub, because
  the file shipped with the code.

---

## Prerequisites

- **`gh` CLI**, authenticated with `repo` scope — `gh auth status` should show you logged in.
  `dispatch release` shells out to `gh release create`.
- **Push access to `origin` `main`.**
- A **clean working tree on `main`, in sync with `origin/main`.** `dispatch release` refuses
  otherwise (see the guards it enforces, below).

---

## The steps

### 1. Land your changes on `main`

Merge your feature branch and push. Everything you want in the release must already be on
`origin/main` — the tag is just a pointer to a commit that's already there.

### 2. Bump the version in all four `package.json`

Dispatch is a pnpm monorepo; the version lives in **four** files and they must match:

```
package.json
packages/cli/package.json
packages/core/package.json
packages/web/package.json
```

Pick the next [semver](https://semver.org): **patch** for fixes/docs, **minor** for features,
**major** for breaking changes. Most releases are a patch bump.

### 3. Write the release note — REQUIRED

Add `docs/releases/vX.Y.Z.md`. **`dispatch release` refuses to tag without it**, and refuses
if the file is empty. This file *is* the GitHub Release body (`gh release create
--notes-file`), and it *is* what every user reads in the update prompt before they install.
Write it for that reader, not for a changelog robot.

The house shape, which every note in `docs/releases/` follows:

```markdown
# Dispatch vX.Y.Z — <short headline, lower case, no trailing period>

## The change

What is different now, from the user's side. Lead with what they will see.

## What was wrong        <!-- optional: only for fixes -->

The behaviour being corrected, and why it happened.

## Under the hood        <!-- optional -->

Internal notes: refactors, new tests, removed dead code.

## Updating

Whether this is **web-only** (a browser refresh is enough) or needs a
**daemon rebuild/restart** (`dispatch update`).
```

Two rules the UI depends on:

- **Keep the `# Dispatch vX.Y.Z — headline` H1 as the first line.** The notes panel splits
  that line off and shows the headline as a subtitle next to the version, so the version is
  never printed twice. A note with no H1 still renders; it just loses the subtitle.
- **Keep it readable at ~12px in a 320px-tall scroll box.** Short paragraphs and bullets
  read well there. Very long notes are truncated at 8,000 characters.

### 4. Commit the bump and push

Follow the existing convention — one commit, this subject line:

```bash
git commit -am "chore(release): X.Y.Z — <short headline>"
git push origin main
```

(`git log --oneline | grep 'chore(release)'` shows the house style.)

### 5. Cut the release

From a **clean `main`, in sync with `origin/main`**:

```bash
./bin/dispatch release          # bumps the patch of the latest tag (vA.B.C → vA.B.(C+1))
./bin/dispatch release 2.9.0    # or name the version explicitly
```

That's it. The command tags, pushes the tag, and creates the GitHub Release.

---

## What `dispatch release` actually does

Source: `packages/cli/src/index.ts` (`cmdRelease`). In order, it:

1. Checks `gh` is installed (aborts with an install hint if not).
2. **Refuses if the working tree is dirty** — commit or stash first.
3. **Refuses if you're not on `main`.**
4. `git fetch origin main --tags`.
5. **Refuses if local `HEAD` ≠ `origin/main`** — push or pull first.
6. Determines the version: your argument, or (with no argument) the patch bump of the newest
   `v*` tag.
7. **Refuses if `docs/releases/<version>.md` is missing or empty.**
8. **Refuses if the root `package.json` version ≠ the version being released.**
9. **Refuses if that tag already exists.**
10. `git tag -a <version>` → `git push origin <version>` →
    `gh release create <version> --repo davidwebber10/dispatch --notes-file docs/releases/<version>.md`.

Note what it does **not** do: it does not edit `package.json`, does not build, and does not
write the release note. Those are steps 2–4 above, and they must already be on `main`.

Guards 7 and 8 exist because both failures are silent and expensive. A missing note leaves
users with an "Update available" prompt and nothing to judge it by. A stale `package.json`
leaves every install nagging forever, and it is only visible hours later.

---

## What a release *does not* do

- **It does not build or bundle anything.** The GitHub Release is a source pointer. Installs
  build from source when they update.
- **It does not deploy to any machine.** Each install upgrades itself with
  `dispatch update` (git pull + rebuild + restart). Deploying to the user's own Mac mini is a
  **separate, opt-in** step — **ask first**; never fold it into a release.
- **It does not restart the local daemon.** If you want *this* machine on the new version,
  that's `dispatch update` (or a manual rebuild + `dispatch restart`) — a deploy, not a release.

---

## Gotchas

- **Working from a git worktree?** `dispatch release` requires `HEAD` to be *on the branch
  `main`* — a worktree checked out on a feature branch will fail guard #3, and you can't check
  `main` out in two worktrees at once. Either cut the release from the primary `main` checkout,
  or run the three git/`gh` commands from step 8 by hand against the commit you already pushed
  to `origin/main` (re-check the latest tag first — see below).
- **Concurrent sessions.** Other agents may be pushing to `main` or cutting releases at the
  same time. Re-run `git fetch origin main --tags` and re-check `git tag -l 'v*' --sort=-v:refname | head`
  right before you tag, so you don't collide on a version. A non-fast-forward push being
  rejected is the *safe* failure — re-fetch, rebase your bump, and retry. Never force-push
  `main` or a tag.
- **Forgot the `package.json` bump.** `dispatch release` now refuses instead of letting this
  through. If an older release already went out this way, delete the tag and release, land
  the bump, and re-tag: `git push origin :vX.Y.Z && gh release delete vX.Y.Z`.
- **Fixing a note after the release is out.** Editing `docs/releases/vX.Y.Z.md` on `main`
  does *not* change what installs display — they read the GitHub Release body, which was
  copied at tag time. Update the body too:
  `gh release edit vX.Y.Z --notes-file docs/releases/vX.Y.Z.md`. Installs pick the new text
  up on their next poll, within about 45 minutes.
- **The notes will not appear on installs older than v2.11.0.** The code that reads them
  shipped in 2.11.0, so an install still on 2.10.0 shows the plain prompt with no notes row.
  It gets the full panel from its *next* update onward. Nothing to fix — just do not expect
  the feature to appear retroactively.

---

## Quick reference

```bash
# 1. everything you want shipped is already on origin/main
git checkout main && git pull

# 2. bump all four package.json to X.Y.Z (root + cli + core + web)
# 3. write docs/releases/vX.Y.Z.md   ← REQUIRED; the release refuses without it

# 4. commit + push the bump and the note together
git commit -am "chore(release): X.Y.Z — <headline>"
git push origin main

# 5. tag + GitHub Release (publishes the note as the release body)
./bin/dispatch release            # auto-bumps patch, or: ./bin/dispatch release X.Y.Z
```

Where the pieces live, if you need to change how any of this behaves:

| Concern | File |
| --- | --- |
| The guards + `--notes-file` | `packages/cli/src/index.ts` (`cmdRelease`) |
| Polling GitHub, keeping the notes | `packages/core/src/update/checker.ts` |
| Note parsing, caps, reading from disk | `packages/core/src/update/notes.ts` |
| Serving them to the browser | `packages/core/src/routes/state.ts` (`GET /update`) |
| The expandable panel | `packages/web/src/components/update/ReleaseNotes.tsx` |
