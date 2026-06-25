import { describe, expect, test, vi } from 'vitest';
import { runCommand } from '../src/index.js';

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
});
