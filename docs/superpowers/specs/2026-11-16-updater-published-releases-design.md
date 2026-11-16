# Updater: install only published releases on main, and move back when ahead

Date: 2026-11-16. Status: approved in chat (owner picked option C plus four add-ons). Target
release: v4.9.0.

## What went wrong

The updater has two halves that disagreed.

- The check (`packages/core/src/update/checker.ts`) reads GitHub's release list and skips drafts
  and prereleases. That is right.
- The install (`apply.ts` in core, and a copy of the same code in `packages/cli/src/index.ts`)
  took the highest `vX.Y.Z` tag on origin. It did not ask whether the tag had a published
  release, or whether the tag was on `main`.

On 2026-11-13 an unreleased tag (4.8.0, on a feature branch) was the highest tag. One install
updated to it. A copy that runs a version above the newest release says "up to date", so it never
moved back.

A second fault made the banner wrong: release 4.7.8 was cut by hand. The root `package.json` said
4.7.8, but `packages/core` and `packages/web` still said 4.7.7. The daemon reads its version from
`packages/core`, so it offered 4.7.8 again after installing it.

## Rule

One rule, one function, used by the check and by both install paths:

> The target is the newest PUBLISHED GitHub release (not a draft, not a prerelease, tag shaped
> `vX.Y.Z`) whose tag commit is reachable from `origin/main`.

If GitHub cannot be reached, answers with something that is not a release list, or no release
qualifies, the install stops with a plain message. It never falls back to "the highest tag".

Where the code lives: `packages/core/src/update/target.ts`, exported to the CLI as
`dispatch-server/update-target`. The CLI copy of `latestReleaseTag` and the core copy are deleted.

### How the rule reads git

- `git fetch origin +refs/heads/main:refs/remotes/origin/main` (a remote-tracking ref, so a force
  is safe).
- `git ls-remote --tags origin` gives origin's tag to commit map. A peeled line (`NAME^{}`) wins
  over the tag object line. Origin's list is the truth; a stray local tag never counts.
- A release qualifies when its tag is in that map and
  `git merge-base --is-ancestor COMMIT refs/remotes/origin/main` succeeds.
- The install merges the commit SHA, not the tag name, so a local tag with the same name cannot
  redirect it. Tags are no longer fetched by the update.

## The move

The new `classifyMove` compares `HEAD`, the target commit and the version this checkout runs:

| Situation | Move |
| --- | --- |
| `HEAD` is the target | nothing to do |
| `HEAD` is an ancestor of the target | fast-forward (`merge --ff-only`) |
| the target is an ancestor of `HEAD`, same or older version | nothing to do (a dev checkout of `main` past the tag is NOT ahead) |
| the version is higher than the target version | ahead: switch back |
| the checkout has diverged from the target (neither contains the other), any version | needs the explicit switch (a move to the release, same gates as switching back) |

"Ahead" is decided by version number, as approved: running version strictly higher than the
target's version, whatever the git shape (an unreleased tag that is on another branch is diverged
from `main`, so the version is the only honest signal).

### Switch back

Moving back is not a fast-forward and it is never automatic.

- It needs an explicit action: the Switch button in the app (the apply request carries
  `switchBack: true`), or `dispatch update --switch-back`. Without it the update stops and says
  what to run.
- It also covers a checkout that has DIVERGED from the release on a lower version (an unreleased
  branch; added after review): without the explicit switch it stops and names the switch.
- It needs a clean working tree. The check asks git for untracked files explicitly
  (`--untracked-files=all`), so a `status.showUntrackedFiles=no` setting cannot hide a file that
  the reset would overwrite. Ignored files are not checked. "Update anyway" does not apply to it.
- It needs the current branch to be `main` (or a detached `HEAD`). On another branch it refuses
  and tells the person to switch to `main` first.
- It first creates the branch `dispatch-backup/vOLD-SHA7` at the old `HEAD`, then runs
  `git reset --hard TARGET_COMMIT`. The message names the backup branch so the old state is one
  `git switch` away. An existing branch of that name is reused only when it points at exactly the old
  HEAD; otherwise the next free name (`-2`, `-3`, ...) is used.

## The check, without blocking the daemon

The daemon's 15-minute check reads origin with an asynchronous git (a 20 second timeout, no
password or SSH prompt), so a slow network cannot stop the event loop. The release list is read
page by page (up to 3 pages of 100) before a target is chosen. When the check cannot tell (GitHub
or origin unreadable, or no release on main), it stores a plain reason (`last_check_error`) that
Settings shows instead of "up to date". When a check changes what is stored without a release to
announce (an ahead state, a removed target, an error), it sends the quiet event `update:checked`
and open pages reload the state.

## What the app shows

`GET /api/state/update` and `POST /api/update/check` gain `ahead`: `null`, or
`{ version, url, publishedAt }` for the release the person can switch back to. The stored target
is kept even when it is not newer, so the check can tell "up to date" from "ahead".

- Settings → Updates: a row "You run v4.8.0, which is not a published release. The latest release
  is v4.7.8." with a Switch button. The Settings dot and banner count it as pending.
- The modal does not pop up for it (it is a state to fix, not news).
- Hosted boxes never report `ahead` (they move by image).

## Versions and process

- The four `package.json` versions (root, cli, core, web) must match. A test
  (`packages/core/tests/release-versions.test.ts`) fails when they do not, so a hand cut is
  visible in CI before it reaches a tag. This change brings core, cli and web up to 4.7.8 to match
  the root.
- 4.9.0 follows the documented flow: the version bump and the release note land in a separate
  `chore(release): 4.9.0` commit on `main`, then `dispatch release` tags it. This pull request
  carries a draft of `docs/releases/v4.9.0.md` and does not bump to 4.9.0.
- AGENTS.md says: releases go only through `dispatch release`. Never `git tag` or
  `gh release create` by hand, and never bump one `package.json` alone.

## Not in this change

- Old installs keep their old updater until they reach 4.9.0, so origin's tags must stay clean
  (every `vX.Y.Z` tag on origin must be a published release on `main`) until people are on 4.9.0.
- A shallow clone cannot prove a tag is on `main`; it stops with the "no release" message.
- The update does not choose a branch for the checkout; it moves the branch that is checked out.

## Tests (written first)

Shared rule: an unreleased higher tag is ignored; a draft and a prerelease are ignored; a
release whose tag is off `main` is ignored; GitHub down, a non-list answer and an empty result
stop; a peeled tag wins; `classifyMove` for each row of the table, including a same-version dev
checkout not being ahead. Then the check, the preflight, the apply route, `cmdUpdate`
(`--switch-back`, backup branch, clean-tree and branch refusals) and the web store and rows.
