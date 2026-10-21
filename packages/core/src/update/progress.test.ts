import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readUpdateProgress, markUpdateStarted, markUpdateFailed, finishRestartedUpdate } from './progress.js';

let dir: string;
let logPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-progress-'));
  logPath = path.join(dir, 'update.log');
});
const write = (s: Record<string, unknown>) => fs.writeFileSync(path.join(dir, 'update-status.json'), JSON.stringify({ v: 1, steps: ['pull', 'install', 'build', 'tools', 'restart'], skipped: [], error: null, ...s }));
const read = (o: { alive?: boolean; now?: Date } = {}) => readUpdateProgress({ dataDir: dir, logPath, isAlive: () => o.alive ?? true, now: o.now });

describe('update progress', () => {
  it('is idle with no status file', () => {
    expect(read()).toMatchObject({ state: 'idle', log: [] });
  });

  it('reports the running step and the log lines of this update only, without ANSI codes', () => {
    write({ state: 'running', pid: 4242, startedAt: '2026-10-15T20:00:00.000Z', step: 'build', stepStartedAt: '2026-10-15T20:00:20.000Z' });
    fs.writeFileSync(logPath, '[dispatch] Update started 2026-10-14T00:00:00Z\nold run line\n[dispatch] Update started 2026-10-15T20:00:00Z\nAlready up to date.\n\x1b[32mpackages/web build: ✓ built in 15.90s\x1b[39m\n');
    const p = read();
    expect(p).toMatchObject({ state: 'running', step: 'build', steps: ['pull', 'install', 'build', 'tools', 'restart'] });
    expect(p.log).toEqual(['Already up to date.', 'packages/web build: ✓ built in 15.90s']);
  });

  it('keeps only the last 40 log lines', () => {
    write({ state: 'running', pid: 1, startedAt: 'x', step: 'build', stepStartedAt: 'x' });
    fs.writeFileSync(logPath, '[dispatch] Update started now\n' + Array.from({ length: 100 }, (_, k) => `line ${k}`).join('\n') + '\n');
    const log = read().log;
    expect(log).toHaveLength(40);
    expect(log.at(-1)).toBe('line 99');
  });

  it('a running update whose updater process is gone is failed', () => {
    write({ state: 'running', pid: 4242, startedAt: 'x', step: 'install', stepStartedAt: 'x' });
    expect(read({ alive: false })).toMatchObject({ state: 'failed', step: 'install', error: 'The updater stopped before it finished.' });
  });

  it('a started update that never got an updater pid fails after 2 minutes', () => {
    markUpdateStarted(dir, new Date('2026-10-15T20:00:00Z'));
    expect(read({ now: new Date('2026-10-15T20:01:00Z') })).toMatchObject({ state: 'running', step: 'pull' });
    expect(read({ now: new Date('2026-10-15T20:02:30Z') })).toMatchObject({ state: 'failed', error: 'The updater did not start.' });
  });

  it('markUpdateFailed records a reason once and never overwrites the step error', () => {
    write({ state: 'running', pid: 1, startedAt: 'x', step: 'build', stepStartedAt: 'x' });
    markUpdateFailed(dir, 'Update failed (exit 1).');
    expect(read()).toMatchObject({ state: 'failed', error: 'Update failed (exit 1).' });
    write({ state: 'failed', pid: 1, startedAt: 'x', step: 'build', stepStartedAt: 'x', error: 'Command failed: pnpm -r run build' });
    markUpdateFailed(dir, 'Update failed (exit 1).');
    expect(read().error).toBe('Command failed: pnpm -r run build');
  });

  it('the restarted daemon turns "restarting" into "done" with its version; other states stay', () => {
    write({ state: 'restarting', pid: 1, startedAt: 'x', step: 'restart', stepStartedAt: 'x' });
    finishRestartedUpdate(dir, '3.1.0', new Date('2026-10-15T20:01:00Z'));
    expect(read({ alive: false })).toMatchObject({ state: 'done', version: '3.1.0', finishedAt: '2026-10-15T20:01:00.000Z' });
    write({ state: 'failed', pid: 1, startedAt: 'x', step: 'build', stepStartedAt: 'x', error: 'e' });
    finishRestartedUpdate(dir, '3.1.0');
    expect(read().state).toBe('failed');
  });

  it('a garbled status file reads as idle', () => {
    fs.writeFileSync(path.join(dir, 'update-status.json'), '{not json');
    expect(read().state).toBe('idle');
  });
});
