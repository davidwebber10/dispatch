// W1-B: `dispatch install` passes DISPATCH_BIND to the daemon; `dispatch status` prints the listen address.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('child_process', () => ({ execFileSync: vi.fn(() => ''), spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })) }));

import { bindEnv, runCommand } from '../src/index.js';

const { spawnSync: spawnSyncReal } = await vi.importActual<typeof import('child_process')>('child_process');

const mkDaemon = (status: { loaded: boolean; pid?: number } = { loaded: true, pid: 42 }) => ({
  install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), status: vi.fn(() => status),
});

let dir: string;
let logged: string[];
beforeEach(() => {
  for (const n of ['DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_TERMINAL_ID', 'DISPATCH_TERMINAL', 'DISPATCH_API']) vi.stubEnv(n, '');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cli-bind-'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((s) => { logged.push(String(s)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('bindEnv (what install bakes into the daemon environment)', () => {
  test('unset or empty adds nothing, so the daemon listens as before', () => {
    expect(bindEnv({})).toEqual({});
    expect(bindEnv({ DISPATCH_BIND: '' })).toEqual({});
    expect(bindEnv({ DISPATCH_BIND: '  ' })).toEqual({});
  });
  test('an IP literal or localhost is passed on, trimmed', () => {
    expect(bindEnv({ DISPATCH_BIND: '127.0.0.1' })).toEqual({ DISPATCH_BIND: '127.0.0.1' });
    expect(bindEnv({ DISPATCH_BIND: ' ::1 ' })).toEqual({ DISPATCH_BIND: '::1' });
    expect(bindEnv({ DISPATCH_BIND: '[::1]' })).toEqual({ DISPATCH_BIND: '::1' });
    expect(bindEnv({ DISPATCH_BIND: 'localhost' })).toEqual({ DISPATCH_BIND: 'localhost' });
  });
  test('an invalid value throws a clear message, so install never writes a daemon that cannot start', () => {
    expect(() => bindEnv({ DISPATCH_BIND: 'example.com' })).toThrow(/DISPATCH_BIND="example.com" is not valid.*IP address.*"localhost"/);
    expect(() => bindEnv({ DISPATCH_BIND: '127.0.0.1:3456' })).toThrow(/DISPATCH_BIND/);
  });
});

describe('install', () => {
  test('DISPATCH_BIND in the context environment reaches daemon.install, as PORT does', () => {
    const daemon = mkDaemon();
    runCommand(['install'], { daemon, port: 3456, env: { PORT: '3456', DISPATCH_BIND: '127.0.0.1' } } as any);
    expect(daemon.install).toHaveBeenCalledOnce();
    expect(daemon.install.mock.calls[0][0].env).toMatchObject({ PORT: '3456', DISPATCH_BIND: '127.0.0.1' });
  });
  test('without it the environment has no DISPATCH_BIND', () => {
    const daemon = mkDaemon();
    runCommand(['install'], { daemon, port: 3456, env: { PORT: '3456' } } as any);
    expect('DISPATCH_BIND' in daemon.install.mock.calls[0][0].env).toBe(false);
  });
});

describe('status', () => {
  const writeListen = (info: object) => fs.writeFileSync(path.join(dir, 'listen.json'), JSON.stringify(info));
  const status = (daemon = mkDaemon(), reachable = true) => runCommand(['status'], { daemon, port: 3456, dataDir: dir, probe: () => reachable } as any);
  const line = () => logged.find((l) => l.startsWith('Listens on:'));

  test('prints "Listens on: all interfaces" and the forwarder advice when the daemon has no bind address', () => {
    writeListen({ pid: process.pid, port: 3456, bind: null });
    status();
    expect(line()).toBe('Listens on: all interfaces');
    const advice = logged.join('\n');
    expect(advice).toMatch(/forwarder/);
    expect(advice).toMatch(/DISPATCH_BIND=127\.0\.0\.1/);
    expect(advice).toMatch(/docs\/network-access\.md/);
  });
  test('prints the address when the daemon was started with DISPATCH_BIND, and no bind advice', () => {
    writeListen({ pid: process.pid, port: 3456, bind: '127.0.0.1' });
    status();
    expect(line()).toBe('Listens on: 127.0.0.1 (and the loopback addresses)');
    expect(logged.join('\n')).not.toMatch(/DISPATCH_BIND=/);
  });
  test('a daemon from before this release wrote no file: it listens on all interfaces', () => {
    status();
    expect(line()).toBe('Listens on: all interfaces');
  });
  test('a file from a process that is gone, or for another port, is not believed', () => {
    const child = spawnSyncReal(process.execPath, ['-e', '']); // a pid that has ended
    writeListen({ pid: child.pid, port: 3456, bind: '127.0.0.1' });
    status();
    expect(line()).toBe('Listens on: all interfaces');
    logged.length = 0;
    writeListen({ pid: process.pid, port: 9999, bind: '127.0.0.1' });
    status();
    expect(line()).toBe('Listens on: all interfaces');
  });
  test('the pid is not compared with the service manager: a daemon from "dispatch run" is believed', () => {
    writeListen({ pid: process.pid, port: 3456, bind: '100.64.0.9' });
    status(mkDaemon({ loaded: true, pid: 1 }));
    expect(line()).toBe('Listens on: 100.64.0.9 (and the loopback addresses)');
    logged.length = 0;
    status(mkDaemon({ loaded: false }));
    expect(line()).toBe('Listens on: 100.64.0.9 (and the loopback addresses)');
  });
  test('a daemon that does not answer gets no "Listens on" line', () => {
    writeListen({ pid: process.pid, port: 3456, bind: null });
    status(mkDaemon({ loaded: false }), false);
    expect(line()).toBeUndefined();
  });
});
