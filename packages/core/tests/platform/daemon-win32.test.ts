import { describe, expect, test, vi } from 'vitest';
import { createWin32Daemon } from '../../src/platform/daemon-win32.js';

vi.mock('fs', () => ({
  default: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('win32 daemon (schtasks command construction)', () => {
  const opts = {
    port: 3456, nodePath: 'C:\\node.exe', entry: 'C:\\repo\\dist\\server.js',
    repoRoot: 'C:\\repo', env: { PORT: '3456' }, logDir: 'C:\\logs',
  };
  test('install registers a task from generated XML with /F', () => {
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn((cmd: string, args: string[]) => { calls.push([cmd, args]); return ''; });
    const d = createWin32Daemon(run, () => 'DOMAIN\\user');
    d.install(opts);
    const create = calls.find(([c, a]) => c === 'schtasks' && a.includes('/Create'));
    expect(create).toBeTruthy();
    expect(create![1]).toEqual(expect.arrayContaining(['/Create', '/TN', 'Dispatch', '/XML', '/F']));
  });
  test('start/stop/uninstall use /Run /End /Delete', () => {
    const calls: string[][] = [];
    const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return ''; };
    const d = createWin32Daemon(run, () => 'u');
    d.start(); d.stop(); d.uninstall();
    expect(calls.some((c) => c.includes('/Run'))).toBe(true);
    expect(calls.some((c) => c.includes('/End'))).toBe(true);
    expect(calls.some((c) => c.includes('/Delete'))).toBe(true);
  });
  test('status parses schtasks /Query Running/Ready', () => {
    const run = () => 'TaskName: \\Dispatch\r\nStatus: Running\r\n';
    const d = createWin32Daemon(run, () => 'u');
    expect(d.status().loaded).toBe(true);
  });
});
