import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { getRunningVersion } from './version.js';
import { collectPendingNotes } from './notes.js';
import { makeAsyncGitExec } from './apply.js';
import { loadEligibleReleases, ReleaseSourceError, type AsyncGitExec, type GitExec } from './target.js';
import { storedUpdateView } from './stored.js';

// 15 min (was 45): a release that lands soon after the last check is not shown as the latest for
// long. Four unauthenticated calls an hour, well inside GitHub's 60.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface CheckForUpdateOptions {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  repo?: string;
  /** The checkout the rule reads origin's main and tags from. */
  repoDir?: string;
  /** Test seam: a git runner in place of real git on `repoDir`. */
  git?: GitExec | AsyncGitExec;
}

/**
 * One poll of the repo's releases, compared against the running version. Stores the
 * result in app_state and broadcasts `update:available` only when the newest release is
 * genuinely newer than what's running — exported standalone (rather than only reachable
 * via the interval) so tests can drive a single tick deterministically.
 *
 * Which releases count is the shared rule in `target.ts` (published, on origin/main), the same one the
 * install uses, so the version shown is the version installed. The stored target is the newest such
 * release even when it is NOT newer than the running version: that is how a copy that runs an
 * unreleased version is told apart from one that is up to date (`storedUpdateView`).
 *
 * This reads the release *list*, not `/releases/latest`, so an install that skipped
 * versions can show the notes for every version it skipped, not only the target's.
 */
export async function checkForUpdateOnce(
  db: Database.Database,
  broadcaster: EventBroadcaster,
  opts?: CheckForUpdateOptions,
): Promise<void> {
  const currentVersion = opts?.currentVersion ?? getRunningVersion();
  // The daemon's own runner is asynchronous with a timeout: a slow or dropped network must not stop the daemon.
  const git = opts?.git ?? (opts?.repoDir ? makeAsyncGitExec(opts.repoDir) : null);
  if (!git) { console.warn('update check: no checkout to read origin from'); return; }

  const before = JSON.stringify(storedUpdateView(db, currentVersion));
  // Tell connected clients when the stored answer changed but there is no release to announce (an "ahead"
  // state found at start-up, a target that went away, an error): they reload quietly, without the modal.
  const tellIfChanged = () => {
    if (JSON.stringify(storedUpdateView(db, currentVersion)) !== before) broadcaster.broadcast({ type: 'update:checked' });
  };

  let eligible;
  try {
    eligible = await loadEligibleReleases(git, { fetchImpl: opts?.fetchImpl, repo: opts?.repo });
  } catch (err) {
    // The rule already logged the detail. Keep what is stored, but say that this check could not tell: Settings
    // must not read "up to date" when the check never saw GitHub or origin.
    let message = 'The update check failed.';
    if (err instanceof ReleaseSourceError) { console.warn(`update check: ${err.message}`); message = err.message; }
    else console.error('update check failed', err);
    appState.set(db, 'last_check_error', message);
    tellIfChanged();
    return;
  }
  appState.set(db, 'last_check_error', '');

  appState.set(db, 'last_checked_ts', new Date().toISOString());

  const newest = eligible[0];
  if (!newest) {
    // Nothing published on main: forget a stale target rather than keep offering it.
    appState.set(db, 'latest_release_tag', '');
    appState.set(db, 'latest_release_url', '');
    appState.set(db, 'latest_release_published_at', '');
    appState.set(db, 'latest_release_notes', '[]');
    appState.set(db, 'last_check_error', 'No published release on main was found, so there is nothing to update to.');
    tellIfChanged();
    return;
  }

  const pending = collectPendingNotes(eligible, currentVersion);
  appState.set(db, 'latest_release_tag', newest.tag_name);
  appState.set(db, 'latest_release_url', newest.html_url ?? '');
  appState.set(db, 'latest_release_published_at', newest.published_at ?? '');
  appState.set(db, 'latest_release_notes', JSON.stringify(pending));
  if (pending.length === 0) { tellIfChanged(); return; }

  // The event keeps its original shape. Notes travel over REST instead of the socket:
  // they can run to tens of kilobytes, and every client refetches `/api/state/update`
  // when this arrives anyway.
  broadcaster.broadcast({
    type: 'update:available',
    version: newest.tag_name,
    url: newest.html_url ?? '',
    publishedAt: newest.published_at ?? '',
  });
}

/** Checks immediately, then every `intervalMs` (default 15 min). */
export function startUpdateCheckLoop(
  db: Database.Database,
  broadcaster: EventBroadcaster,
  repoDir: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  void checkForUpdateOnce(db, broadcaster, { repoDir });
  return setInterval(() => { void checkForUpdateOnce(db, broadcaster, { repoDir }); }, intervalMs);
}
