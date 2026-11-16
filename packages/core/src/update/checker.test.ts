import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as appState from '../db/app-state.js';
import type { EventBroadcaster } from '../ws/events.js';
import { checkForUpdateOnce } from './checker.js';
import { fakeGit } from './fake-git.fixture.js';
import { storedUpdateView } from './stored.js';

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

/** Every tag these tests use is on main, unless a test builds its own world. */
const TAGS = ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v1.9.0', 'v2.0.0'];
const onMain = () => fakeGit({ tags: Object.fromEntries(TAGS.map((t) => [t, `c-${t}`])), main: TAGS.map((t) => `c-${t}`) });

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

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git: onMain() });

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

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.1.0', fetchImpl, git: onMain() });

    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/releases\?per_page=\d+&page=1$/);
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

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git: onMain() });

    expect(appState.get(db, 'latest_release_tag')).toBe('v1.2.0');
    expect(broadcaster.events).toHaveLength(1);
  });

  it('is a no-op (no broadcast) when the latest release matches the running version', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git: onMain() });

    expect(broadcaster.events).toEqual([]);
    // The target is stored even when it is not newer: that is how "up to date" differs from "ahead".
    expect(appState.get(db, 'latest_release_tag')).toBe('v1.0.0');
    expect(appState.get(db, 'latest_release_notes')).toBe('[]');
    // Still records that a check happened, for observability.
    expect(appState.get(db, 'last_checked_ts')).not.toBeNull();
  });

  it('is a no-op when the running version is already ahead of the latest release', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.1.0', fetchImpl, git: onMain() });

    // No release to announce: only the quiet "state changed" event, with no update:available.
    expect(broadcaster.events).toEqual([{ type: 'update:checked' }]);
    // ...and it is reported as ahead, not as up to date.
    expect(storedUpdateView(db, '1.1.0')).toMatchObject({ available: false, ahead: { version: 'v1.0.0' } });
  });

  it('a running version equal to the newest release is neither available nor ahead', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.0.0', fetchImpl, git: onMain() });
    expect(storedUpdateView(db, '1.0.0')).toEqual({ available: false, version: null, url: null, publishedAt: null, ahead: null, checkError: null });
  });

  it('ignores a release whose tag is not on main, even though it is the newest published', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v2.0.0'), release('v1.2.0')]));
    const git = fakeGit({ tags: { 'v1.2.0': 'c12', 'v2.0.0': 'c20' }, main: ['c12'] });

    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git });

    expect(appState.get(db, 'latest_release_tag')).toBe('v1.2.0');
    expect(broadcaster.events).toHaveLength(1);
  });

  it('a tag that is higher but has no published release is never the target (the 4.8.0 case)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));
    const git = fakeGit({ tags: { 'v1.0.0': 'c10', 'v1.1.0': 'c11' }, main: ['c10', 'c11'] });
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.0.0', fetchImpl, git });
    expect(appState.get(db, 'latest_release_tag')).toBe('v1.0.0');
  });

  it('forgets a stored target when no release qualifies any more', async () => {
    appState.set(db, 'latest_release_tag', 'v1.2.0');
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.2.0')]));
    const git = fakeGit({ tags: { 'v1.2.0': 'c12' }, main: [] });
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.0.0', fetchImpl, git });
    expect(storedUpdateView(db, '1.0.0').available).toBe(false);
  });

  it('leaves what is stored when git cannot read origin', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    appState.set(db, 'latest_release_tag', 'v1.2.0');
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.2.0')]));
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.0.0', fetchImpl, git: fakeGit({ fetchFails: true }) });
    expect(appState.get(db, 'latest_release_tag')).toBe('v1.2.0');
    expect(appState.get(db, 'last_checked_ts')).toBeNull();
  });

  it('does not throw and keeps the stored release when the GitHub API errors', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse({}, false, 404));

    await expect(checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git: onMain() })).resolves.toBeUndefined();

    // No release to announce: only the quiet "state changed" event, with no update:available.
    expect(broadcaster.events).toEqual([{ type: 'update:checked' }]);
    expect(appState.get(db, 'last_checked_ts')).toBeNull();
  });

  it('does not throw when the API returns something that is not a list', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse({ message: 'rate limited' }));

    await expect(checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git: onMain() })).resolves.toBeUndefined();
    // No release to announce: only the quiet "state changed" event, with no update:available.
    expect(broadcaster.events).toEqual([{ type: 'update:checked' }]);
    expect(appState.get(db, 'last_checked_ts')).toBeNull();
  });

  it('does not throw when the fetch itself rejects (network error)', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(checkForUpdateOnce(db, broadcaster, { currentVersion: '1.0.0', fetchImpl, git: onMain() })).resolves.toBeUndefined();
    // No release to announce: only the quiet "state changed" event, with no update:available.
    expect(broadcaster.events).toEqual([{ type: 'update:checked' }]);
  });
});

describe('what the check tells clients and Settings', () => {
  it('broadcasts update:checked when it finds an "ahead" state with no release to announce', async () => {
    const broadcaster = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));
    await checkForUpdateOnce(db, broadcaster, { currentVersion: '1.1.0', fetchImpl, git: onMain() });
    expect(broadcaster.events).toEqual([{ type: 'update:checked' }]);
  });

  it('says nothing more when a second check changes nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.1.0', fetchImpl, git: onMain() });
    const b = fakeBroadcaster();
    await checkForUpdateOnce(db, b, { currentVersion: '1.1.0', fetchImpl, git: onMain() });
    expect(b.events).toEqual([]);
  });

  it('broadcasts update:checked when a stale target is removed', async () => {
    appState.set(db, 'latest_release_tag', 'v1.2.0');
    const b = fakeBroadcaster();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.2.0')]));
    await checkForUpdateOnce(db, b, { currentVersion: '1.0.0', fetchImpl, git: fakeGit({ tags: { 'v1.2.0': 'c12' }, main: [] }) });
    expect(b.events).toEqual([{ type: 'update:checked' }]);
    expect(storedUpdateView(db, '1.0.0').checkError).toMatch(/No published release on main/);
  });

  it('stores why a check could not tell, so Settings does not read "up to date", and clears it after a good check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = fakeBroadcaster();
    await checkForUpdateOnce(db, b, { currentVersion: '1.0.0', fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) as any, git: onMain() });
    expect(storedUpdateView(db, '1.0.0').checkError).toMatch(/reach GitHub/);
    expect(b.events).toEqual([{ type: 'update:checked' }]);
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.0.0')]));
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.0.0', fetchImpl, git: onMain() });
    expect(storedUpdateView(db, '1.0.0').checkError).toBeNull();
  });

  it('reads origin through a git that answers asynchronously', async () => {
    const inner = onMain();
    const fetchImpl = vi.fn().mockResolvedValue(releaseResponse([release('v1.2.0')]));
    await checkForUpdateOnce(db, fakeBroadcaster(), { currentVersion: '1.0.0', fetchImpl, git: async (a) => inner(a) });
    expect(appState.get(db, 'latest_release_tag')).toBe('v1.2.0');
  });
});
