import type { GitHubRelease } from './notes.js';
import { isNewerVersion } from './version.js';

/**
 * The ONE rule for which release an install moves to, used by the update check, the daemon's preflight
 * and `dispatch update` (the CLI imports this module as `dispatch-server/update-target`):
 *
 *   the target is the newest PUBLISHED GitHub release (not a draft, not a prerelease, tag shaped vX.Y.Z)
 *   whose tag commit is reachable from origin/main.
 *
 * It never falls back to "the highest tag": on 2026-11-13 that fallback moved an install onto a tag
 * that was never released and was not on main. Every failure here is a plain message, not a guess.
 * See docs/superpowers/specs/2026-11-16-updater-published-releases-design.md.
 */

export const RELEASE_REPO = 'davidwebber10/dispatch';
const TAG_SHAPE = /^v\d+\.\d+\.\d+$/;
const MAIN_REF = 'refs/remotes/origin/main';

/** Runs a git subcommand against the checkout and returns stdout; throws on non-zero exit. */
export type GitExec = (args: string[]) => string;
/** The same, without blocking the caller: the daemon's background check uses this one. */
export type AsyncGitExec = (args: string[]) => Promise<string>;

/** A failure the person can read: no folder, remote or home path in the text. The detail goes to the log. */
export class ReleaseSourceError extends Error {}

/** The move was refused. `needsSwitchBack` marks the one refusal an explicit switch would lift. */
export class MoveRefused extends Error {
  needsSwitchBack?: boolean;
  constructor(message: string, opts?: { needsSwitchBack?: boolean }) {
    super(message);
    if (opts?.needsSwitchBack) this.needsSwitchBack = true;
  }
}

/** A step's failure as a client may see it: the step, and a pointer to the log. */
export function stepFailed(what: string, err: unknown): string {
  console.error(`[update] ${what}:`, (err as Error)?.message ?? err);
  return `${what}. The detail is in the Dispatch daemon log.`;
}

export interface FetchReleasesOptions {
  repo?: string;
  fetchImpl?: typeof fetch;
  /** Page size (default 100). */
  perPage?: number;
  timeoutMs?: number;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 3;

/**
 * GitHub's release list for the repo, as sent (drafts and prereleases are dropped later, in one place).
 * It follows up to three pages of 100: one short page cannot show the newest eligible release when
 * newer prereleases or off-main releases fill it. A page that fails stops the whole read, so a target is
 * never chosen from half a list.
 */
export async function fetchReleaseList(opts: FetchReleasesOptions = {}): Promise<GitHubRelease[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const repo = opts.repo ?? RELEASE_REPO;
  const perPage = opts.perPage ?? PAGE_SIZE;
  const all: GitHubRelease[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${perPage}&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      console.error('[update] release list request failed:', (err as Error)?.message ?? err);
      throw new ReleaseSourceError('Could not reach GitHub to find the latest release, so nothing was changed.');
    }
    if (!res.ok) throw new ReleaseSourceError(`GitHub answered ${res.status} when asked for the latest release, so nothing was changed.`);
    let body: unknown;
    try { body = await res.json(); } catch { body = null; }
    if (!Array.isArray(body)) throw new ReleaseSourceError('GitHub sent an answer that is not a release list, so nothing was changed.');
    all.push(...(body as GitHubRelease[]));
    if (body.length < perPage) break;
  }
  return all;
}

/** What origin says about tags and main. */
export interface MainView {
  /** tag name -> the commit it points at, from origin's own list. */
  tagCommits: Map<string, string>;
  /** Is this commit reachable from origin/main? */
  onMain: (commit: string) => Promise<boolean>;
}

/**
 * Fetches origin's main (a remote-tracking ref, so a force is safe) and reads origin's tag list.
 * Origin's list is the truth: a tag that exists only in this checkout never counts. A peeled line
 * (`NAME^{}`) is the commit of an annotated tag and wins over the tag object's own line.
 */
export async function readMainView(git: GitExec | AsyncGitExec): Promise<MainView> {
  let listing: string;
  try {
    await git(['fetch', 'origin', `+refs/heads/main:${MAIN_REF}`]);
    listing = await git(['ls-remote', '--tags', 'origin']);
  } catch (err) {
    throw new ReleaseSourceError(stepFailed('Could not read the release tags from origin, so nothing was changed', err));
  }
  const plain = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of listing.split('\n')) {
    const m = /^(\S+)\s+refs\/tags\/(.+?)(\^\{\})?\s*$/.exec(line.trim());
    if (!m) continue;
    (m[3] ? peeled : plain).set(m[2], m[1]);
  }
  const tagCommits = new Map(plain);
  for (const [tag, commit] of peeled) tagCommits.set(tag, commit);
  const cache = new Map<string, boolean>();
  const onMain = async (commit: string): Promise<boolean> => {
    const hit = cache.get(commit);
    if (hit !== undefined) return hit;
    let answer: boolean;
    try { await git(['merge-base', '--is-ancestor', commit, MAIN_REF]); answer = true; } catch (err) { answer = ancestorNo(err); }
    cache.set(commit, answer);
    return answer;
  };
  return { tagCommits, onMain };
}

/**
 * `git merge-base --is-ancestor A B`: exit 0 yes, 1 no. Exit 128 means git does not know a commit,
 * which for "is it on main" is also a no (main is fully fetched). Anything else is a real failure.
 */
function isAncestor(git: GitExec, a: string, b: string): boolean {
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch (err) { return ancestorNo(err); }
}

/** A failed `merge-base --is-ancestor`: 1 and 128 are "no"; anything else is rethrown. */
function ancestorNo(err: unknown): false {
  const status = (err as { status?: number })?.status;
  if (status === 1 || status === 128) return false;
  throw err;
}

export interface EligibleRelease extends GitHubRelease {
  /** The commit the release's tag points at on origin. */
  commit: string;
}

/** The published releases whose tag commit is on main, newest first. The whole rule, in one place. */
export async function eligibleReleases(releases: GitHubRelease[], view: MainView): Promise<EligibleRelease[]> {
  const out: EligibleRelease[] = [];
  for (const r of releases) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string' || !TAG_SHAPE.test(r.tag_name)) continue;
    const commit = view.tagCommits.get(r.tag_name);
    if (!commit || !(await view.onMain(commit))) continue;
    out.push({ ...r, commit });
  }
  return out.sort((a, b) => (isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0));
}

/** Asks GitHub and origin, and returns the eligible releases, newest first. Throws ReleaseSourceError. */
export async function loadEligibleReleases(git: GitExec | AsyncGitExec, opts: FetchReleasesOptions = {}): Promise<EligibleRelease[]> {
  const releases = await fetchReleaseList(opts);
  return eligibleReleases(releases, await readMainView(git));
}

export interface ReleaseTarget {
  /** The tag, e.g. `v4.7.8`. */
  tag: string;
  /** The version without the leading v. */
  version: string;
  commit: string;
  url: string;
  publishedAt: string;
}

export function targetOf(r: EligibleRelease): ReleaseTarget {
  return { tag: r.tag_name, version: r.tag_name.replace(/^v/, ''), commit: r.commit, url: r.html_url ?? '', publishedAt: r.published_at ?? '' };
}

/** The release to install. Throws ReleaseSourceError, so an install stops instead of guessing. */
export async function resolveTarget(git: GitExec | AsyncGitExec, opts: FetchReleasesOptions = {}): Promise<ReleaseTarget> {
  const list = await loadEligibleReleases(git, opts);
  if (list.length === 0) {
    throw new ReleaseSourceError('No published release on main was found, so there is nothing to update to.');
  }
  return targetOf(list[0]);
}

export type Move = 'current' | 'forward' | 'back';

const aheadMessage = (version: string, target: ReleaseTarget) =>
  `This copy (v${version}) is newer than the latest release (v${target.version}). `
  + `To move back to it, run "dispatch update --switch-back" or choose Switch in the app. `
  + `Your current commit is kept on a backup branch.`;

const divergedMessage = (version: string, target: ReleaseTarget) =>
  `This copy (v${version}) has diverged from release ${target.tag}: it has commits the release does not contain, so it cannot move forward. `
  + `To move to the release anyway, run "dispatch update --switch-back" or choose Switch in the app. `
  + `Your current commit is kept on a backup branch.`;

/**
 * Decides, without changing anything, how this checkout gets to the target, or why it cannot.
 *
 * "Ahead" is the running version being strictly higher than the target's: a dev checkout of main a
 * few commits past the release, with the same version, is not ahead. A checkout that has diverged
 * from the release (its commits are not in the release, whatever its version) needs the same switch.
 * Moving there is never a fast-forward and never automatic: it needs `allowBack`, a clean tree, and
 * `main` (or a detached HEAD) checked out. The caller that executes the move is `moveToTarget`.
 */
export function planMove(git: GitExec, target: ReleaseTarget, o: { version: string; allowBack: boolean }): Move {
  let head: string;
  try {
    head = git(['rev-parse', 'HEAD']).trim();
  } catch (err) {
    throw new MoveRefused(stepFailed('Could not read this checkout', err));
  }
  if (head === target.commit) return 'current';
  let headBehind: boolean;
  let headAhead: boolean;
  try {
    headBehind = isAncestor(git, head, target.commit);
    headAhead = !headBehind && isAncestor(git, target.commit, head);
  } catch (err) {
    throw new MoveRefused(stepFailed(`Could not compare this checkout with ${target.tag}`, err));
  }
  if (headBehind) return 'forward';
  const ahead = isNewerVersion(o.version, target.version);
  // A dev checkout of main past the release, with the same (or an older) version, is not ahead and stays.
  if (!ahead && headAhead) return 'current';
  // Two situations need the explicit switch: the version is HIGHER than the release (ahead), or this
  // checkout has commits the release does not contain (diverged: an unreleased branch). Neither is a
  // fast-forward, so neither happens by itself.
  if (!o.allowBack) {
    throw new MoveRefused(ahead ? aheadMessage(o.version, target) : divergedMessage(o.version, target), { needsSwitchBack: true });
  }
  let dirty: string;
  let branch: string;
  try {
    // --untracked-files=all: a status.showUntrackedFiles=no setting must not hide a file that reset would overwrite.
    dirty = git(['status', '--porcelain', '--untracked-files=all']);
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch (err) {
    throw new MoveRefused(stepFailed('Could not read this checkout', err));
  }
  if (dirty.trim().length > 0) {
    throw new MoveRefused('Moving back needs a clean working tree. Commit or stash your changes first.');
  }
  if (branch !== 'main' && branch !== 'HEAD') {
    throw new MoveRefused(`Moving back works from the main branch, and this checkout is on ${branch}. Switch to main first.`);
  }
  return 'back';
}

/**
 * The branch that keeps the old HEAD: `dispatch-backup/vOLD-SHA7`. An existing branch of that name is
 * reused only when it points at exactly this HEAD (the full commit, not the short one); if it points
 * elsewhere (moved by hand, or a short-SHA collision), the next free name `-2`, `-3`, ... is used.
 */
function backupBranchFor(git: GitExec, head: string, version: string): { name: string; create: boolean } {
  const base = `dispatch-backup/v${version}-${head.slice(0, 7)}`;
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    let at: string | null = null;
    try { at = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).trim() || null; } catch { at = null; }
    if (at === null) return { name, create: true };
    if (at === head) return { name, create: false };
  }
  throw new MoveRefused('Too many backup branches already exist for this commit. Delete the old dispatch-backup branches, then try again.');
}

/**
 * Carries the move out. A forward move merges the commit with --ff-only (the commit, not the tag
 * name, so a local tag of the same name cannot redirect it). A move back first keeps the old HEAD on
 * a branch named `dispatch-backup/vOLD-SHA7`, then resets this branch to the release.
 */
export function moveToTarget(git: GitExec, target: ReleaseTarget, o: { version: string; allowBack: boolean }): { move: Move; backup?: string } {
  const move = planMove(git, target, o);
  if (move === 'forward') {
    git(['merge', '--ff-only', target.commit]);
    return { move };
  }
  if (move === 'back') {
    const head = git(['rev-parse', 'HEAD']).trim();
    const backup = backupBranchFor(git, head, o.version);
    if (backup.create) git(['branch', backup.name, head]);
    git(['reset', '--hard', target.commit]);
    return { move, backup: backup.name };
  }
  return { move };
}
