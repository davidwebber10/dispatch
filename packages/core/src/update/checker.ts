import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { getRunningVersion, isNewerVersion } from './version.js';

const DEFAULT_REPO = 'davidwebber10/dispatch';
const DEFAULT_INTERVAL_MS = 45 * 60 * 1000; // 45 min — within the requested 30-60 min window

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
}

export interface CheckForUpdateOptions {
  currentVersion?: string;
  fetchImpl?: typeof fetch;
  repo?: string;
}

/**
 * One poll of GitHub's "latest release" for the repo, compared against the running
 * version. Stores the result in app_state and broadcasts `update:available` only when
 * the release is genuinely newer than what's running — exported standalone (rather than
 * only reachable via the interval) so tests can drive a single tick deterministically.
 */
export async function checkForUpdateOnce(
  db: Database.Database,
  broadcaster: EventBroadcaster,
  opts?: CheckForUpdateOptions,
): Promise<void> {
  const currentVersion = opts?.currentVersion ?? getRunningVersion();
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const repo = opts?.repo ?? DEFAULT_REPO;

  let release: GitHubRelease | null = null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) release = (await res.json()) as GitHubRelease;
    else console.warn(`update check: GitHub API returned ${res.status}`);
  } catch (err) {
    console.error('update check failed', err);
    return;
  }
  if (!release?.tag_name) return;

  appState.set(db, 'last_checked_ts', new Date().toISOString());
  if (!isNewerVersion(release.tag_name, currentVersion)) return;

  appState.set(db, 'latest_release_tag', release.tag_name);
  appState.set(db, 'latest_release_url', release.html_url ?? '');
  appState.set(db, 'latest_release_published_at', release.published_at ?? '');

  broadcaster.broadcast({
    type: 'update:available',
    version: release.tag_name,
    url: release.html_url,
    publishedAt: release.published_at,
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
