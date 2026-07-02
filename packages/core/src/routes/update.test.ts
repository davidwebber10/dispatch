import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createUpdateRouter } from './update.js';
import type { EventBroadcaster } from '../ws/events.js';
import type { GitExec } from '../update/apply.js';

function app(broadcaster: EventBroadcaster, gitExec: GitExec, applyFn: (repoDir: string) => void) {
  const a = express();
  a.use('/api/update', createUpdateRouter(broadcaster, '/repo', { gitExec, applyFn }));
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
