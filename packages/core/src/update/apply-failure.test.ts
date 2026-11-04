// packages/core/src/update/apply-failure.test.ts
// SEC sweep: the update failure that every client sees (the broadcast) names no folder. The same plain reason goes to the status file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => ({ tmp: '', child: null as any }));
vi.mock('../platform/index.js', () => ({
  platform: { logDir: () => `${h.tmp}/logs`, dataDir: () => `${h.tmp}/data` },
}));
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), spawn: () => h.child }));

import { applyUpdate } from './apply.js';
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
