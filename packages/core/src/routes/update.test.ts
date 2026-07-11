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
  a.use('/api/update', createUpdateRouter(broadcaster, '/repo', db, { gitExec, applyFn, ...opts }));
  return a;
}

const CLEAN_AND_FF_ABLE: Record<string, string> = {
  'status --porcelain': '',
  'fetch origin': '',
  'rev-parse --abbrev-ref HEAD': 'main\n',
  'rev-parse HEAD': 'abc123\n',
  'rev-parse origin/main': 'def456\n',
  'merge-base --is-ancestor abc123 def456': '',
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

  it('returns 409 when the branch has diverged from origin', async () => {
    const events: Record<string, unknown>[] = [];
    const broadcaster: EventBroadcaster = { broadcast: (e) => { events.push(e); } };
    const applyFn = vi.fn();
    // Simulate the real execFileSync throw for a failed --is-ancestor check.
    const gitWithDivergence: GitExec = (args) => {
      const key = args.join(' ');
      if (key === 'merge-base --is-ancestor abc123 def456') throw new Error('exit code 1');
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
