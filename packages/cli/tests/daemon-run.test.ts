import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
vi.mock('child_process', () => ({ spawnSync: vi.fn(), execFileSync: vi.fn() }));
import { spawnSync } from 'child_process';
import { cmdDaemonRun, runCommand } from '../src/index.js';
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }); });

test('logon startup restores installed port/env and writes child output to daemon logs', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-daemon-test-')); dirs.push(dataDir);
  const logDir = path.join(dataDir, 'logs');
  fs.writeFileSync(path.join(dataDir, 'daemon.json'), JSON.stringify({
    port: 4567, nodePath: '/installed/node', entry: '/installed/server.js', repoRoot: '/installed',
    logDir, env: { PORT: '9999', SAVED_SETTING: 'kept' },
  }));
  vi.mocked(spawnSync).mockImplementation((command, args, options: any) => {
    expect(command).toBe('/installed/node'); expect(args).toEqual(['/installed/server.js']);
    expect(options.cwd).toBe('/installed');
    expect(options.env.PORT).toBe('4567'); expect(options.env.SAVED_SETTING).toBe('kept');
    fs.writeSync(options.stdio[1], 'listening\n'); fs.writeSync(options.stdio[2], 'diagnostic\n');
    return { status: 3 } as any;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  expect(() => runCommand(['daemon-run'], { dataDir, port: 3456 } as any)).toThrow('exit');
  expect(exit).toHaveBeenCalledWith(3);
  expect(fs.readFileSync(path.join(logDir, 'dispatch.out.log'), 'utf8')).toBe('listening\n');
  expect(fs.readFileSync(path.join(logDir, 'dispatch.err.log'), 'utf8')).toBe('diagnostic\n');
});

test('invalid installed settings fail explicitly instead of silently starting on the wrong port', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-daemon-test-')); dirs.push(dataDir);
  fs.writeFileSync(path.join(dataDir, 'daemon.json'), '{}');
  expect(() => cmdDaemonRun({ dataDir } as any)).toThrow('Invalid daemon.json');
});
