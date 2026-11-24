// packages/core/src/update/apply-failure.test.ts
// SEC sweep: the update failure that every client sees (the broadcast) names no folder. The same plain reason goes to the status file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ tmp: '', child: null as any, spawned: [] as any[] }));
vi.mock('../platform/index.js', () => ({
  platform: { logDir: () => `${h.tmp}/logs`, dataDir: () => `${h.tmp}/data` },
}));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: (...a: any[]) => { h.spawned = a; return h.child; } }));

import { applyUpdate, updaterEnv } from './apply.js';
import { EventEmitter } from 'node:events';

beforeEach(() => {
  h.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-apply-fail-'));
  fs.mkdirSync(`${h.tmp}/data`);
  h.child = Object.assign(new EventEmitter(), { unref: () => {} });
});
afterEach(() => { fs.rmSync(h.tmp, { recursive: true, force: true }); });

describe('applyUpdate failure text', () => {
  it('a spawn error: the broadcast carries no path; the log keeps the detail', () => {
    const seen: string[] = [];
    applyUpdate('/Users/someone/dispatch', (reason) => seen.push(reason));
    h.child.emit('error', new Error('spawn /Users/someone/dispatch/bin/dispatch ENOENT'));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/Could not start updater/);
    expect(seen[0]).not.toMatch(/\/Users|someone|dispatch-apply-fail/);
    expect(fs.readFileSync(`${h.tmp}/logs/update.log`, 'utf8')).toMatch(/ENOENT/);
  });

  it('a non-zero exit: no path either', () => {
    const seen: string[] = [];
    applyUpdate('/Users/someone/dispatch', (reason) => seen.push(reason));
    h.child.emit('exit', 1, null);
    expect(seen[0]).toMatch(/Update failed \(exit 1\)/);
    expect(seen[0]).not.toMatch(/\/|someone/);
  });
});

describe('applyUpdate argv', () => {
  it('runs `dispatch update` alone by default', () => {
    applyUpdate('/repo', () => {});
    expect(h.spawned[1]).toEqual(['update']);
  });

  it('adds --switch-back only when the caller says so', () => {
    applyUpdate('/repo', () => {}, { switchBack: true });
    expect(h.spawned[1]).toEqual(['update', '--switch-back']);
  });
});

describe('applyUpdate node', () => {
  it('spawns the updater with the daemon node first on PATH, whatever the daemon PATH says', () => {
    applyUpdate('/repo', () => {});
    const env = h.spawned[2].env as NodeJS.ProcessEnv;
    expect(env.PATH!.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
  });

  it('updaterEnv moves the node dir to the front once and keeps the rest in order', () => {
    const env = updaterEnv({ PATH: '/fnm/shim/bin:/usr/bin:/d/v24/bin:/bin', HOME: '/h' }, '/d/v24/bin/node');
    expect(env.PATH).toBe('/d/v24/bin:/fnm/shim/bin:/usr/bin:/bin');
    expect(env.HOME).toBe('/h');
  });
});
