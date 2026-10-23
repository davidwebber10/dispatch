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
  a.use('/api/update', createUpdateRouter(broadcaster, '/repo', db, { gitExec, applyFn, ...opts }));
  return a;
}

const CLEAN_AND_FF_ABLE: Record<string, string> = {
  'status --porcelain': '',
  'fetch origin --tags': '',
  'tag -l v* --sort=-v:refname': 'v3.5.0\nv3.4.0\n',
  'rev-parse HEAD': 'abc123\n',
  'rev-parse v3.5.0^{commit}': 'def456\n',
  'merge-base --is-ancestor abc123 def456': '',
  'merge-base --is-ancestor def456 abc123': '',
};

function fakeGit(responses: Record<string, string>): GitExec {
  return (args) => {
    const key = args.join(' ');
    if (!(key in responses)) throw new Error(`unexpected git invocation: ${key}`);
    return responses[key];
  };
}

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

  it('returns 409 with the failure reason and never applies when the tree is dirty', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();
    const dirtyGit = fakeGit({ ...CLEAN_AND_FF_ABLE, 'status --porcelain': ' M foo.ts\n' });

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
    const dirtyGit = fakeGit({ ...CLEAN_AND_FF_ABLE, 'status --porcelain': ' M a.ts\n' });

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
    const dirtyButForceableGit = fakeGit({ ...CLEAN_AND_FF_ABLE, 'status --porcelain': ' M a.ts\n' });

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
    const dirtyAndDivergedGit: GitExec = (args) => {
      const key = args.join(' ');
      if (key === 'status --porcelain') return ' M a.ts\n';
      if (key.startsWith('merge-base --is-ancestor')) throw new Error('exit code 1');
      return CLEAN_AND_FF_ABLE[key];
    };

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
    // Simulate the real execFileSync throw for a failed --is-ancestor check.
    const gitWithDivergence: GitExec = (args) => {
      const key = args.join(' ');
      if (key.startsWith('merge-base --is-ancestor')) throw new Error('exit code 1');
      return CLEAN_AND_FF_ABLE[key];
    };

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

  it('reports up-to-date when the check stores nothing newer', async () => {
    const broadcaster: EventBroadcaster = { broadcast: () => {} };
    const res = await request(app(broadcaster, fakeGit(CLEAN_AND_FF_ABLE), vi.fn(), { checkFn: async () => {} })).post('/api/update/check');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.version).toBeNull();
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
