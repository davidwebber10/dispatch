import { describe, expect, test, vi } from 'vitest';
import { runCommand, lastLines, probeHttp } from '../src/index.js';

describe('dispatch CLI routing', () => {
  test('install → daemon.install; status → daemon.status', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: true, pid: 1 })) };
    runCommand(['install'], { daemon, port: 3456 } as any);
    expect(daemon.install).toHaveBeenCalledOnce();
    runCommand(['status'], { daemon, port: 3456 } as any);
    expect(daemon.status).toHaveBeenCalledOnce();
  });
  test('unknown command throws a usage error', () => {
    expect(() => runCommand(['bogus'], {} as any)).toThrow(/usage/i);
  });

  test('tools → toolsRunner with passthrough args', () => {
    const toolsRunner = vi.fn();
    runCommand(['tools', 'install', '--force'], { toolsRunner } as any);
    expect(toolsRunner).toHaveBeenCalledOnce();
    expect(toolsRunner).toHaveBeenCalledWith(['install', '--force']);
  });
});

describe('status HTTP probe', () => {
  test('prints reachable when probe returns true', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: true, pid: 42 })) };
    const probe = vi.fn(() => true);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => logged.push(s));
    runCommand(['status'], { daemon, port: 3456, probe } as any);
    expect(logged.some(l => l.includes('reachable'))).toBe(true);
    vi.restoreAllMocks();
  });

  test('prints not responding when probe returns false', () => {
    const daemon = { install: vi.fn(), uninstall: vi.fn(), start: vi.fn(), stop: vi.fn(),
      restart: vi.fn(), status: vi.fn(() => ({ loaded: false })) };
    const probe = vi.fn(() => false);
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((s) => logged.push(s));
    runCommand(['status'], { daemon, port: 3456, probe } as any);
    expect(logged.some(l => l.includes('not responding'))).toBe(true);
    vi.restoreAllMocks();
  });

  test('probeHttp returns reachable string when probe returns true', () => {
    expect(probeHttp(3456, () => true)).toBe('HTTP: reachable at http://localhost:3456');
  });

  test('probeHttp returns not responding string when probe returns false', () => {
    expect(probeHttp(3456, () => false)).toBe('HTTP: not responding on http://localhost:3456');
  });
});

describe('lastLines', () => {
  test('returns last n lines', () => {
    expect(lastLines('a\nb\nc\nd', 2)).toBe('c\nd');
  });
  test('returns all lines when fewer than n', () => {
    expect(lastLines('a\nb', 10)).toBe('a\nb');
  });
  test('single line with no newline', () => {
    expect(lastLines('hello', 5)).toBe('hello');
  });
  test('trailing newline does not produce an extra empty line', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc');
  });
  test('empty string returns empty string', () => {
    expect(lastLines('', 5)).toBe('');
  });
  test('n=0 returns empty string', () => {
    expect(lastLines('a\nb\nc', 0)).toBe('');
  });
});
