# Cutting a release

How to ship a new version of Dispatch. Written for an agent (or maintainer) working in this
repo. If you only remember one thing, remember this:

> **A release is a git tag + a GitHub Release. The version in `package.json` is a *separate*
> hand-authored commit. Both must move together, or the in-app update prompt never fires
> correctly.** `dispatch release` does only the tag half.

Cutting a release is **not** the same as deploying. See [What a release does *not* do](#what-a-release-does-not-do).

---

## The mental model — two halves that must move together

The auto-updater compares two numbers:

| Half | Where it lives | Who reads it | Moved by |
| --- | --- | --- | --- |
| **The tag** | `vX.Y.Z` on GitHub (the newest [Release](https://github.com/davidwebber10/dispatch/releases)) | every install polls `GET /releases/latest` (`packages/core/src/update/checker.ts`) | `dispatch release` |
| **The running version** | `version` in the four `package.json` files | the daemon reads its own `packages/core/package.json` (`getRunningVersion()`, `packages/core/src/update/version.ts`) | a hand-authored `chore(release)` commit |

The daemon polls GitHub roughly every 45 minutes and shows the update banner **only when the
latest release tag is strictly newer than the version it was built from**
(`isNewerVersion(tag, running)`).

So:

- **Tag bumped, `package.json` forgotten** → a freshly-updated install still reports the old
  version and the banner never clears. It nags forever.
- **`package.json` bumped, tag forgotten** → GitHub's "latest release" stays old and **no
  install is ever notified**.

`dispatch release` only ever touches the tag. **You** own the `package.json` bump, and it has
to be committed and pushed to `main` *before* you tag.

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

### 3. Write a release note (recommended)

Add `docs/releases/vX.Y.Z.md`. Look at a recent one (e.g. `docs/releases/v2.8.10.md`) for the
shape: a one-line headline, **The change**, then **what was wrong / under the hood**, and — if
it matters to whoever's updating — whether it's a *web-only* change (a browser refresh is
enough) or needs a *daemon rebuild/restart*. `gh` also auto-generates notes from commit
messages (`--generate-notes`), so this file is the human-readable companion, not the only
source.

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
7. **Refuses if that tag already exists.**
8. `git tag -a <version>` → `git push origin <version>` →
   `gh release create <version> --repo davidwebber10/dispatch --generate-notes`.

Note what it does **not** do: it does not edit `package.json`, does not build, and does not
write the release note. Those are steps 2–4 above, and they must already be on `main`.

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
- **Forgot the `package.json` bump.** If you tagged but never bumped, delete the tag and
  release, land the bump, and re-tag: `git push origin :vX.Y.Z && gh release delete vX.Y.Z`.

---

## Quick reference

```bash
# 1. everything you want shipped is already on origin/main
git checkout main && git pull

# 2. bump all four package.json to X.Y.Z (root + cli + core + web)
# 3. write docs/releases/vX.Y.Z.md (recommended)

# 4. commit + push the bump
git commit -am "chore(release): X.Y.Z — <headline>"
git push origin main

# 5. tag + GitHub Release
./bin/dispatch release            # auto-bumps patch, or: ./bin/dispatch release X.Y.Z
```
