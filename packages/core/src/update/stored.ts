import type Database from 'better-sqlite3';
import * as appState from '../db/app-state.js';
import { isNewerVersion } from './version.js';

/** A release the person can move to: the shape `GET /api/state/update` sends for `ahead`. */
export interface ReleaseRef { version: string; url: string | null; publishedAt: string | null }

export interface StoredUpdateView {
  /** The newest eligible release is newer than the running version. */
  available: boolean;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  /**
   * The running version is HIGHER than the newest eligible release (stuck on an unreleased version):
   * the release the person can switch back to. Null otherwise. A same-version dev checkout is not ahead.
   */
  ahead: ReleaseRef | null;
  /**
   * Why the last check could not tell (GitHub or origin unreadable, or no release on main), as a plain
   * sentence; null after a check that worked. Settings shows it instead of "up to date".
   */
  checkError: string | null;
}

/**
 * What the update check stored, re-read against the running version on every call. The stored tag is
 * a cache, never a trusted flag: a daemon that already updated must not offer the update it just took.
 * The stored target is the newest eligible release even when it is not newer (see checker.ts), so
 * "up to date" and "ahead" can be told apart.
 */
export function storedUpdateView(db: Database.Database, currentVersion: string): StoredUpdateView {
  const tag = appState.get(db, 'latest_release_tag');
  const url = appState.get(db, 'latest_release_url');
  const publishedAt = appState.get(db, 'latest_release_published_at');
  const available = !!tag && isNewerVersion(tag, currentVersion);
  const ahead = !!tag && isNewerVersion(currentVersion, tag);
  return {
    available,
    version: available ? tag : null,
    url: available ? url : null,
    publishedAt: available ? publishedAt : null,
    ahead: ahead ? { version: tag!, url: url || null, publishedAt: publishedAt || null } : null,
    checkError: appState.get(db, 'last_check_error') || null,
  };
}
