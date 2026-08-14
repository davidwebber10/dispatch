import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { getRunningVersion } from './version.js';
import { collectPendingNotes, MAX_NOTES, type GitHubRelease } from './notes.js';

const DEFAULT_REPO = 'davidwebber10/dispatch';
const DEFAULT_INTERVAL_MS = 45 * 60 * 1000; // 45 min — within the requested 30-60 min window

export interface CheckForUpdateOptions {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  repo?: string;
}

/**
 * One poll of the repo's releases, compared against the running version. Stores the
 * result in app_state and broadcasts `update:available` only when the newest release is
 * genuinely newer than what's running — exported standalone (rather than only reachable
 * via the interval) so tests can drive a single tick deterministically.
 *
 * This reads the release *list*, not `/releases/latest`, so an install that skipped
 * versions can show the notes for every version it skipped, not only the target's.
 * Drafts and prereleases are filtered out, which `/releases/latest` used to do for us.
 */
export async function checkForUpdateOnce(
  db: Database.Database,
  broadcaster: EventBroadcaster,
  opts?: CheckForUpdateOptions,
): Promise<void> {
  const currentVersion = opts?.currentVersion ?? getRunningVersion();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const repo = opts?.repo ?? DEFAULT_REPO;

  let releases: GitHubRelease[] | null = null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${MAX_NOTES * 3}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body)) releases = body as GitHubRelease[];
      else console.warn('update check: GitHub API returned a non-array release list');
    } else console.warn(`update check: GitHub API returned ${res.status}`);
  } catch (err) {
    console.error('update check failed', err);
    return;
  }
  if (!releases) return;

  appState.set(db, 'last_checked_ts', new Date().toISOString());

  const pending = collectPendingNotes(releases, currentVersion);
  if (pending.length === 0) return;
  const newest = pending[0];

  appState.set(db, 'latest_release_tag', newest.version);
  appState.set(db, 'latest_release_url', newest.url);
  appState.set(db, 'latest_release_published_at', newest.publishedAt);
  appState.set(db, 'latest_release_notes', JSON.stringify(pending));

  // The event keeps its original shape. Notes travel over REST instead of the socket:
  // they can run to tens of kilobytes, and every client refetches `/api/state/update`
  // when this arrives anyway.
  broadcaster.broadcast({
    type: 'update:available',
    version: newest.version,
    url: newest.url,
    publishedAt: newest.publishedAt,
  });
}

/** Checks immediately, then every `intervalMs` (default ~45 min). */
export function startUpdateCheckLoop(
  db: Database.Database,
  broadcaster: EventBroadcaster,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): NodeJS.Timeout {
  void checkForUpdateOnce(db, broadcaster);
  return setInterval(() => { void checkForUpdateOnce(db, broadcaster); }, intervalMs);
}
