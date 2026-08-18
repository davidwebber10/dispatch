import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { checkForUpdateOnce } from './checker.js';

let dir: string;
let db: Database.Database;

function fakeBroadcaster(): EventBroadcaster & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return { events, broadcast: (e) => { events.push(e); } };
}

function releaseResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** One entry as GitHub's `GET /repos/:repo/releases` returns it. */
function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    html_url: `https://github.com/davidwebber10/dispatch/releases/tag/${tag}`,
    published_at: '2026-01-01T00:00:00Z',
    body: `notes for ${tag}`,
    draft: false,
    prerelease: false,
    ...extra,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-'));
  db = createDatabase(path.join(dir, 'test.db'));
});
afterEach(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  vi.restoreAllMocks();
});

describe('checkForUpdateOnce', () => {
  it('broadcasts update:available and persists app_state when the release is newer', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.2.0')]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl });

    expect(broadcaster.events).toEqual([{
      type: 'update:available',
      version: 'v1.2.0',
      url: 'https://github.com/davidwebber10/dispatch/releases/tag/v1.2.0',
      publishedAt: '2026-01-01T00:00:00Z',
    }]);
    expect(appState.get(db, 'latest_release_tag')).toBe('v1.2.0');
    expect(appState.get(db, 'latest_release_url')).toBe('https://github.com/davidwebber10/dispatch/releases/tag/v1.2.0');
    expect(appState.get(db, 'last_checked_ts')).not.toBeNull();
  });

  it('reads the release LIST, so the notes cover every skipped version, newest first', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([
      release('v1.0.0'), release('v1.3.0'), release('v1.1.0'), release('v1.2.0'),
    ]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.1.0', fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/releases\?per_page=\d+$/);
    const stored = JSON.parse(appState.get(db, 'latest_release_notes')!);
    expect(stored.map((n: { version: string }) => n.version)).toEqual(['v1.3.0', 'v1.2.0']);
    expect(stored[0].notes).toBe('notes for v1.3.0');
    // The prompt still targets the newest of them.
    expect(appState.get(db, 'latest_release_tag')).toBe('v1.3.0');
  });

  it('ignores drafts and prereleases when picking the newest release', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([
      release('v2.0.0', { draft: true }),
      release('v1.9.0', { prerelease: true }),
      release('v1.2.0'),
    ]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl });

    expect(appState.get(db, 'latest_release_tag')).toBe('v1.2.0');
    expect(broadcaster.events).toHaveLength(1);
  });

  it('is a no-op (no broadcast) when the latest release matches the running version', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl });

    expect(broadcaster.events).toEqual([]);
    expect(appState.get(db, 'latest_release_tag')).toBeNull();
    expect(appState.get(db, 'latest_release_notes')).toBeNull();
    // Still records that a check happened, for observability.
    expect(appState.get(db, 'last_checked_ts')).not.toBeNull();
  });

  it('is a no-op when the running version is already ahead of the latest release', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.1.0', fetchImpl });

    expect(broadcaster.events).toEqual([]);
  });

  it('does not throw and does not touch app_state when the GitHub API errors', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse({}, false, 404));

    await expect(checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl })).resolves.toBeUndefined();

    expect(broadcaster.events).toEqual([]);
    expect(appState.get(db, 'last_checked_ts')).toBeNull();
  });

  it('does not throw when the API returns something that is not a list', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse({ message: 'rate limited' }));

    await expect(checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl })).resolves.toBeUndefined();
    expect(broadcaster.events).toEqual([]);
    expect(appState.get(db, 'last_checked_ts')).toBeNull();
  });

  it('does not throw when the fetch itself rejects (network error)', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl })).resolves.toBeUndefined();
    expect(broadcaster.events).toEqual([]);
  });
});
