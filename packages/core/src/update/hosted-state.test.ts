// Box defect #2 (2026-11-11): on a hosted box /api/state/update came from the GitHub poller and said
// "up to date" while OS had a newer image. It must come from OS; the progress has one plain step.
import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedHostedUpdate, resetHostedUpdateCache } from './hosted.js';
import { markHostedUpdateStarted, readUpdateProgress, finishRestartedUpdate } from './progress.js';

afterEach(() => resetHostedUpdateCache());

describe('hosted update state', () => {
  test('the answer comes from OS and is cached', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ available: true, version: '4.7.0' }) });
    const t = { baseUrl: 'http://os', boxToken: 'tok' };
    expect(await cachedHostedUpdate(t, '4.6.0', { fetchImpl: f as any })).toMatchObject({ available: true, version: '4.7.0' });
    await cachedHostedUpdate(t, '4.6.0', { fetchImpl: f as any });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toBe('http://os/api/dispatch/box/update?current=4.6.0');
  });

  test('a hosted update is one plain step, with the labels in the answer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-progress-'));
    const idle = readUpdateProgress({ dataDir: dir, logPath: path.join(dir, 'u.log'), hosted: true });
    expect(idle.steps).toEqual(['rollover']);
    expect(idle.stepLabels).toEqual({ rollover: 'Move your workspace to the new version' });
    markHostedUpdateStarted(dir);
    const p = readUpdateProgress({ dataDir: dir, logPath: path.join(dir, 'u.log'), hosted: true });
    expect(p).toMatchObject({ state: 'restarting', step: 'rollover', steps: ['rollover'] });
    finishRestartedUpdate(dir, '4.7.0');
    expect(readUpdateProgress({ dataDir: dir, logPath: path.join(dir, 'u.log'), hosted: true })).toMatchObject({ state: 'done', version: '4.7.0' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
