/**
 * The GitHub link of a PR or issue source on the pinned card (titles and source panel spec
 * 2026-10-09, Unit 5). The daemon reads the project's remote (`git remote get-url origin` in the
 * project folder), accepts the SSH form (`git@github.com:owner/repo.git`) and the HTTPS form (with
 * or without `.git`), and builds `https://github.com/owner/repo/pull/26` or `/issues/26`. A ref that
 * is already a GitHub URL is used as is. Any other remote, or a git error, gives no link (and no
 * error message). The remote is cached per project folder for 10 minutes.
 */
import { execFileSync } from 'node:child_process';

export const REMOTE_CACHE_MS = 10 * 60_000;

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const REPO = '[A-Za-z0-9._-]+?';
const REMOTE_FORMS = [
  // git@github.com:owner/repo.git
  new RegExp(`^git@github\\.com:(${OWNER})/(${REPO})(?:\\.git)?/?$`),
  // ssh://git@github.com/owner/repo.git
  new RegExp(`^ssh://git@github\\.com/(${OWNER})/(${REPO})(?:\\.git)?/?$`),
  // https://github.com/owner/repo(.git), with an optional user before the host
  new RegExp(`^https://(?:[^@/\\s]+@)?github\\.com/(${OWNER})/(${REPO})(?:\\.git)?/?$`),
];

/** "owner/repo" for a GitHub remote; null for any other remote. */
export function githubRepoFromRemote(remote: string): string | null {
  const r = remote.trim();
  for (const form of REMOTE_FORMS) {
    const m = r.match(form);
    if (m && m[2] !== '.' && m[2] !== '..') return `${m[1]}/${m[2]}`;
  }
  return null;
}

/** The link of a `pr` or `issue` source; null for other kinds, for a ref of another shape, or without a repo. */
export function sourceUrl(kind: string, ref: string | null, repo: string | null): string | null {
  if (kind !== 'pr' && kind !== 'issue') return null;
  const r = (ref ?? '').trim();
  if (/^https:\/\/github\.com\/\S+$/.test(r)) return r;
  const n = r.match(/^#(\d+)$/)?.[1];
  if (!n || !repo) return null;
  return `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`;
}

/** `git remote get-url origin` in `dir`. Throws on a git error (not a repository, no origin, a timeout). */
export function gitOriginUrl(dir: string): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * A reader of a project folder's GitHub repo ("owner/repo" or null), cached per folder for 10
 * minutes; a git error is cached too, as null. Never throws. `run` and `clock` are for tests.
 */
export function createRemoteReader(opts: { run?: (dir: string) => string; clock?: () => number } = {}): (dir: string) => string | null {
  const run = opts.run ?? gitOriginUrl;
  const clock = opts.clock ?? (() => Date.now());
  const cache = new Map<string, { repo: string | null; at: number }>();
  return (dir) => {
    const hit = cache.get(dir);
    if (hit && clock() - hit.at < REMOTE_CACHE_MS) return hit.repo;
    let repo: string | null = null;
    try { repo = githubRepoFromRemote(run(dir)); } catch { /* a git error: no link */ }
    cache.set(dir, { repo, at: clock() });
    return repo;
  };
}
