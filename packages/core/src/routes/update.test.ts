import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/connection.js';
import * as appState from '../db/app-state.js';
import { createUpdateRouter, type CreateUpdateRouterOptions } from './update.js';
import type { EventBroadcaster } from '../ws/events.js';
import type { GitExec } from '../update/apply.js';
import { fakeGit as worldGit, release as githubRelease } from '../update/fake-git.fixture.js';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-route-'));
  db = createDatabase(path.join(dir, 'test.db'));
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

function app(broadcaster: EventBroadcaster, gitExec: GitExec, applyFn: (repoDir: string) => void, opts?: Partial<CreateUpdateRouterOptions>) {
  const a = express();
  a.use(express.json());
  // A no-op release check unless a test brings its own: apply and check refresh from GitHub first.
  a.use('/api/update', createUpdateRouter(broadcaster, '/repo', db, { gitExec, applyFn, checkFn: async () => {}, releasesFetch: releases, ...opts }));
  return a;
}

/** v3.5.0 is published and on main at def456; this checkout (abc123, running 3.4.0) is one commit behind it. */
const WORLD = { tags: { 'v3.4.0': 'old340', 'v3.5.0': 'def456', 'v3.6.0': 'unreleased' }, main: ['old340', 'def456', 'abc123'], head: 'abc123', ancestors: { def456: ['abc123'] } };
const github = (...tags: string[]) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => tags.map((t) => githubRelease(t)) }) as any;
// The preflight reads this checkout's version from the running daemon; the real package.json is far above 3.x,
// so these tests say what the checkout runs.
const running = vi.hoisted(() => ({ version: '3.4.0' }));
vi.mock('../update/version.js', async (orig) => ({ ...(await orig<typeof import('../update/version.js')>()), getRunningVersion: () => running.version }));
beforeEach(() => { running.version = '3.4.0'; });
const CLEAN_AND_FF_ABLE = WORLD;
const fakeGit = (w: Record<string, unknown>): GitExec => worldGit(w as any);
const releases = github('v3.4.0', 'v3.5.0');

describe('POST /api/update/apply', () => {
  it('applies the update and broadcasts update:in-progress when the preflight passes', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();

    const res = await request(app(broadcaster, fakeGit(CLEAN_AND_FF_ABLE), applyFn)).post('/api/update/apply');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(events).toEqual([{ type: 'update:in-progress' }]);
    expect(applyFn).toHaveBeenCalledWith('/repo');
  });

  it('updates to a published release on main, not to a higher tag nobody released', async () => {
    // origin has v3.6.0 (never released). The preflight reads GitHub's list, so the target is v3.5.0.
    const applyFn = vi.fn();
    const res = await request(app({ broadcast: () => {} }, fakeGit(CLEAN_AND_FF_ABLE), applyFn)).post('/api/update/apply');
    expect(res.status).toBe(200);
    expect(applyFn).toHaveBeenCalledWith('/repo');
  });

  it('stops with a plain 409 when GitHub cannot be reached, and applies nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const applyFn = vi.fn();
    const res = await request(app({ broadcast: () => {} }, fakeGit(CLEAN_AND_FF_ABLE), applyFn, { releasesFetch: vi.fn().mockRejectedValue(new Error('offline')) as any })).post('/api/update/apply');
    expect(res.status).toBe(409);
    expect(res.body.reason).toMatch(/reach GitHub/);
    expect(applyFn).not.toHaveBeenCalled();
  });

  describe('a copy that runs a version above the newest release (stuck on an unreleased tag)', () => {
    const ahead = fakeGit({ ...CLEAN_AND_FF_ABLE, head: 'x60', ancestors: {} });
    beforeEach(() => { running.version = '3.6.0'; });

    it('is not moved without the explicit switch: 409 with needsSwitchBack, nothing applied', async () => {
      const events: Record<string, unknown>[] = [];
      const applyFn = vi.fn();
      const res = await request(app({ broadcast: (e) => { events.push(e); } }, ahead, applyFn)).post('/api/update/apply').send({});
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, needsSwitchBack: true });
      expect(res.body.reason).toMatch(/3\.6\.0.*3\.5\.0/s);
      expect(events).toEqual([]);
      expect(applyFn).not.toHaveBeenCalled();
    });

    it('moves back when the request says switchBack, and tells the updater it may', async () => {
      const applyFn = vi.fn();
      const res = await request(app({ broadcast: () => {} }, ahead, applyFn)).post('/api/update/apply').send({ switchBack: true });
      expect(res.status).toBe(200);
      expect(applyFn).toHaveBeenCalledWith('/repo', { switchBack: true });
    });

    it('a dirty tree is refused for a move back even with force', async () => {
      const applyFn = vi.fn();
      const dirty = fakeGit({ ...CLEAN_AND_FF_ABLE, head: 'x60', ancestors: {}, dirty: ' M a.ts\n' });
      const res = await request(app({ broadcast: () => {} }, dirty, applyFn)).post('/api/update/apply').send({ switchBack: true, force: true });
      expect(res.status).toBe(409);
      expect(res.body.reason).toMatch(/clean working tree/);
      expect(applyFn).not.toHaveBeenCalled();
    });
  });

  it('switchBack in the request does not permit anything on a copy that is merely behind', async () => {
    const applyFn = vi.fn();
    const res = await request(app({ broadcast: () => {} }, fakeGit(CLEAN_AND_FF_ABLE), applyFn)).post('/api/update/apply').send({ switchBack: true });
    expect(res.status).toBe(200);
    expect(applyFn).toHaveBeenCalledWith('/repo');
  });

  it('returns 409 with the failure reason and never applies when the tree is dirty', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();
    const dirtyGit = fakeGit({ ...CLEAN_AND_FF_ABLE, dirty: ' M foo.ts\n' });

    const res = await request(app(broadcaster, dirtyGit, applyFn)).post('/api/update/apply');

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toMatch(/uncommitted changes/i);
    expect(events).toEqual([]);
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('the 409 body carries the parsed dirty list and marks the failure forceable', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    const applyFn = vi.fn();
    const dirtyGit = fakeGit({ ...CLEAN_AND_FF_ABLE, dirty: ' M a.ts\n' });

    const res = await request(app(broadcaster, dirtyGit, applyFn)).post('/api/update/apply').send({});

    expect(res.status).toBe(409);
    expect(res.body.dirty).toEqual([{ status: ' M', path: 'a.ts' }]);
    expect(res.body.forceable).toBe(true);
    expect(res.body.dirtyOverflow).toBe(0);
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('force:true reaches apply on a dirty-but-otherwise-fast-forwardable tree', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();
    const dirtyButForceableGit = fakeGit({ ...CLEAN_AND_FF_ABLE, dirty: ' M a.ts\n' });

    const res = await request(app(broadcaster, dirtyButForceableGit, applyFn))
      .post('/api/update/apply')
      .send({ force: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(events).toEqual([{ type: 'update:in-progress' }]);
    expect(applyFn).toHaveBeenCalledWith('/repo');
  });

  it('force:true does NOT skip the fast-forward check — a diverged branch still 409s and is never applied', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    const applyFn = vi.fn();
    const dirtyAndDivergedGit = fakeGit({ ...CLEAN_AND_FF_ABLE, dirty: ' M a.ts\n', head: 'mine', ancestors: {} });

    const res = await request(app(broadcaster, dirtyAndDivergedGit, applyFn))
      .post('/api/update/apply')
      .send({ force: true });

    expect(res.status).toBe(409);
    expect(res.body.reason).toMatch(/diverged/i);
    expect(res.body.forceable).toBeFalsy();
    expect(applyFn).not.toHaveBeenCalled();
  });

  it('returns 409 when the branch has diverged from origin', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();
    const gitWithDivergence = fakeGit({ ...CLEAN_AND_FF_ABLE, head: 'mine', ancestors: {} });

    const res = await request(app(broadcaster, gitWithDivergence, applyFn)).post('/api/update/apply');

    expect(res.status).toBe(409);
    expect(res.body.reason).toMatch(/diverged/i);
    expect(applyFn).not.toHaveBeenCalled();
  });
});

describe('POST /api/update/check', () => {
  it('runs the check and answers with the fresh update state', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    // The injected check stands in for the GitHub poll: it stores a newer release.
    const checkFn = vi.fn(async (d: Database.Database) => {
      appState.set(d, 'latest_release_tag', 'v99.0.0');
      appState.set(d, 'latest_release_url', 'https://example.com/v99');
      appState.set(d, 'latest_release_published_at', '2026-07-10T00:00:00Z');
    });

    const res = await request(app(broadcaster, fakeGit(CLEAN_AND_FF_ABLE), vi.fn(), { checkFn })).post('/api/update/check');

    expect(res.status).toBe(200);
    expect(checkFn).toHaveBeenCalled();
    expect(res.body.available).toBe(true);
    expect(res.body.version).toBe('v99.0.0');
    expect(typeof res.body.currentVersion).toBe('string');
  });

  it('reports ahead, with the release to switch back to, when the running version is above the newest release', async () => {
    running.version = '4.8.0';
    const checkFn = vi.fn(async (d: Database.Database) => {
      appState.set(d, 'latest_release_tag', 'v4.7.8');
      appState.set(d, 'latest_release_url', 'https://example.com/v4.7.8');
      appState.set(d, 'latest_release_published_at', '2026-11-15T00:00:00Z');
    });
    const res = await request(app({ broadcast: () => {} }, fakeGit(CLEAN_AND_FF_ABLE), vi.fn(), { checkFn })).post('/api/update/check');
    expect(res.body).toMatchObject({ available: false, version: null, ahead: { version: 'v4.7.8', url: 'https://example.com/v4.7.8', publishedAt: '2026-11-15T00:00:00Z' } });
  });

  it('reports up-to-date when the check stores nothing newer', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    const res = await request(app(broadcaster, fakeGit(CLEAN_AND_FF_ABLE), vi.fn(), { checkFn: async () => {} })).post('/api/update/check');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.version).toBeNull();
    expect(res.body.ahead).toBeNull();
  });
});

describe('a HOSTED box updates by rolling onto a new image, not by pulling git', () => {
  // The git preflight is not merely unnecessary here, it fails: the image is built
  // with `COPY . .` and .dockerignore excludes `.git`, so `git status` reports
  // "not a git repository" and the update button looks broken. And /app is in the
  // container layer, so a pull would silently revert on the next task restart.
  const HOSTED = { baseUrl: 'http://os.internal', boxToken: 'box-secret' };
  const explodingGit: GitExec = () => { throw new Error('not a git repository'); };

  it('never touches git, asks OS instead, and broadcasts the same progress event', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();
    const hostedApplyFn = vi.fn(async () => ({ ok: true }));

    const res = await request(
      app(broadcaster, explodingGit, applyFn, { hosted: HOSTED, hostedApplyFn }),
    ).post('/api/update/apply');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, hosted: true });
    expect(hostedApplyFn).toHaveBeenCalledWith(HOSTED);
    // The local path must not run at all — spawning `bin/dispatch update` in a
    // container would rebuild into an ephemeral layer and then vanish.
    expect(applyFn).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'update:in-progress' }]);
  });

  it('reports the control plane\'s refusal as 409 and does not claim progress', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const hostedApplyFn = vi.fn(async () => ({ ok: false, reason: 'no newer image has been built' }));

    const res = await request(
      app(broadcaster, explodingGit, vi.fn(), { hosted: HOSTED, hostedApplyFn }),
    ).post('/api/update/apply');

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('no newer image has been built');
    expect(events).toEqual([]);
  });

  it('checks the image registry rather than GitHub releases', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    const checkFn = vi.fn(async () => {});
    const hostedCheckFn = vi.fn(async () => ({
      available: true, version: '2.28.0', currentVersion: '2.27.0',
    }));

    const res = await request(
      app(broadcaster, explodingGit, vi.fn(), { hosted: HOSTED, checkFn, hostedCheckFn }),
    ).post('/api/update/check');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, version: '2.28.0', hosted: true });
    // A GitHub release nobody has built into an image is not an update this box
    // can take, so polling releases here would offer an update that cannot apply.
    expect(checkFn).not.toHaveBeenCalled();
    expect(hostedCheckFn).toHaveBeenCalled();
  });

  it('leaves the local git path completely unchanged when not hosted', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    const applyFn = vi.fn();
    const hostedApplyFn = vi.fn();

    const res = await request(
      app(broadcaster, fakeGit(CLEAN_AND_FF_ABLE), applyFn, { hosted: null, hostedApplyFn }),
    ).post('/api/update/apply');

    expect(res.status).toBe(200);
    expect(applyFn).toHaveBeenCalledWith('/repo');
    expect(hostedApplyFn).not.toHaveBeenCalled();
  });
});

describe('GET /api/update/progress', () => {
  const broadcaster = { broadcast: vi.fn() } as unknown as EventBroadcaster;
  it('answers idle with no update, then the running step and its log lines', async () => {
    const logPath = path.join(dir, 'update.log');
    const a = app(broadcaster, fakeGit({}), () => {}, { dataDir: dir, updateLogPath: logPath });
    expect((await request(a).get('/api/update/progress')).body).toMatchObject({ state: 'idle', log: [] });
    fs.writeFileSync(path.join(dir, 'update-status.json'), JSON.stringify({ v: 1, state: 'running', pid: process.pid, startedAt: 'x', step: 'build', stepStartedAt: 'x', steps: ['pull', 'install', 'build', 'tools', 'restart'], skipped: ['install'], error: null }));
    fs.writeFileSync(logPath, '[dispatch] Update started now\npackages/core build$ tsc\n');
    expect((await request(a).get('/api/update/progress')).body).toMatchObject({ state: 'running', step: 'build', skipped: ['install'], log: ['packages/core build$ tsc'] });
  });

  it('a successful apply marks the update started, so progress shows at once', async () => {
    const a = app(broadcaster, fakeGit(CLEAN_AND_FF_ABLE), () => {}, { dataDir: dir, updateLogPath: path.join(dir, 'update.log') });
    expect((await request(a).post('/api/update/apply').send({})).body).toEqual({ ok: true });
    expect((await request(a).get('/api/update/progress')).body).toMatchObject({ state: 'running', step: 'pull' });
  });
});

describe('the stored release is refreshed before it is shown or installed (2026-11-05)', () => {
  const bc = (): EventBroadcaster => ({ broadcast: vi.fn() });

  it('apply asks GitHub again first, so the notes on screen are the version being installed', async () => {
    const order: string[] = [];
    const checkFn = vi.fn(async () => { order.push('check'); });
    const applyFn = vi.fn(() => { order.push('apply'); });
    const res = await request(app(bc(), fakeGit(CLEAN_AND_FF_ABLE), applyFn, { checkFn })).post('/api/update/apply');
    expect(res.status).toBe(200);
    expect(order).toEqual(['check', 'apply']);
  });

  it('a check made in the last minute is reused, not repeated', async () => {
    appState.set(db, 'last_checked_ts', new Date().toISOString());
    const checkFn = vi.fn(async () => {});
    await request(app(bc(), fakeGit(CLEAN_AND_FF_ABLE), vi.fn(), { checkFn })).post('/api/update/check');
    await request(app(bc(), fakeGit(CLEAN_AND_FF_ABLE), vi.fn(), { checkFn })).post('/api/update/apply');
    expect(checkFn).not.toHaveBeenCalled();
  });

  it('a GitHub that does not answer does not hold the update up for long', async () => {
    const checkFn = vi.fn(() => new Promise<void>(() => {})); // never settles
    const applyFn = vi.fn();
    const res = await request(app(bc(), fakeGit(CLEAN_AND_FF_ABLE), applyFn, { checkFn, checkWaitMs: 50 })).post('/api/update/apply');
    expect(res.status).toBe(200);
    expect(applyFn).toHaveBeenCalled();
  });
});
