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
  /** How many releases to ask for (default 30). */
  perPage?: number;
  timeoutMs?: number;
}

/** GitHub's release list for the repo, as sent (drafts and prereleases are dropped later, in one place). */
export async function fetchReleaseList(opts: FetchReleasesOptions = {}): Promise<GitHubRelease[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const repo = opts.repo ?? RELEASE_REPO;
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${opts.perPage ?? 30}`, {
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
  return body as GitHubRelease[];
}

/** What origin says about tags and main. */
export interface MainView {
  /** tag name -> the commit it points at, from origin's own list. */
  tagCommits: Map<string, string>;
  /** Is this commit reachable from origin/main? */
  onMain: (commit: string) => boolean;
}

/**
 * Fetches origin's main (a remote-tracking ref, so a force is safe) and reads origin's tag list.
 * Origin's list is the truth: a tag that exists only in this checkout never counts. A peeled line
 * (`NAME^{}`) is the commit of an annotated tag and wins over the tag object's own line.
 */
export function readMainView(git: GitExec): MainView {
  let listing: string;
  try {
    git(['fetch', 'origin', `+refs/heads/main:${MAIN_REF}`]);
    listing = git(['ls-remote', '--tags', 'origin']);
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
  const onMain = (commit: string): boolean => {
    const hit = cache.get(commit);
    if (hit !== undefined) return hit;
    const answer = isAncestor(git, commit, MAIN_REF);
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
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 1 || status === 128) return false;
    throw err;
  }
}

export interface EligibleRelease extends GitHubRelease {
  /** The commit the release's tag points at on origin. */
  commit: string;
}

/** The published releases whose tag commit is on main, newest first. The whole rule, in one place. */
export function eligibleReleases(releases: GitHubRelease[], view: MainView): EligibleRelease[] {
  const out: EligibleRelease[] = [];
  for (const r of releases) {
    if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string' || !TAG_SHAPE.test(r.tag_name)) continue;
    const commit = view.tagCommits.get(r.tag_name);
    if (!commit || !view.onMain(commit)) continue;
    out.push({ ...r, commit });
  }
  return out.sort((a, b) => (isNewerVersion(a.tag_name, b.tag_name) ? -1 : isNewerVersion(b.tag_name, a.tag_name) ? 1 : 0));
}

/** Asks GitHub and origin, and returns the eligible releases, newest first. Throws ReleaseSourceError. */
export async function loadEligibleReleases(git: GitExec, opts: FetchReleasesOptions = {}): Promise<EligibleRelease[]> {
  const releases = await fetchReleaseList(opts);
  return eligibleReleases(releases, readMainView(git));
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
export async function resolveTarget(git: GitExec, opts: FetchReleasesOptions = {}): Promise<ReleaseTarget> {
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

/**
 * Decides, without changing anything, how this checkout gets to the target, or why it cannot.
 *
 * "Ahead" is the running version being strictly higher than the target's: a dev checkout of main a
 * few commits past the release, with the same version, is not ahead. Moving back is never a
 * fast-forward and never automatic: it needs `allowBack`, a clean tree, and `main` (or a detached
 * HEAD) checked out. The caller that executes the move is `moveToTarget`.
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
  if (!isNewerVersion(o.version, target.version)) {
    if (headAhead) return 'current';
    throw new MoveRefused(`This checkout has diverged from release ${target.tag}, so it cannot move forward. Resolve that by hand, then run dispatch update again.`);
  }
  // Ahead of the newest release.
  if (!o.allowBack) throw new MoveRefused(aheadMessage(o.version, target), { needsSwitchBack: true });
  let dirty: string;
  let branch: string;
  try {
    dirty = git(['status', '--porcelain']);
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
    const backup = `dispatch-backup/v${o.version}-${head.slice(0, 7)}`;
    let exists = true;
    try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${backup}`]); } catch { exists = false; }
    if (!exists) git(['branch', backup, head]);
    git(['reset', '--hard', target.commit]);
    return { move, backup };
  }
  return { move };
}
