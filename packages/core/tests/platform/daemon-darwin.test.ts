import { describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import { buildPlist, esc, createDarwinDaemon } from '../../src/platform/daemon-darwin.js';
import type { RunnerOpts } from '../../src/platform/daemon-darwin.js';
import type { DaemonInstallOptions } from '../../src/platform/daemon.js';

const baseOpts: DaemonInstallOptions = {
  port: 3456,
  nodePath: '/usr/local/bin/node',
  entry: '/repo/packages/core/dist/server.js',
  repoRoot: '/repo',
  logDir: '/tmp/logs',
  env: { PORT: '3456' },
};

// ── esc() unit tests ─────────────────────────────────────────────────────────

describe('esc()', () => {
  test('escapes & < > " \'', () => {
    expect(esc('a&b<c>"d\'e')).toBe('a&amp;b&lt;c&gt;&quot;d&apos;e');
  });
  test('leaves safe strings unchanged', () => {
    expect(esc('hello world')).toBe('hello world');
  });
  test('handles multiple occurrences of the same character', () => {
    expect(esc('&&')).toBe('&amp;&amp;');
  });
});

// ── buildPlist XML-escaping ──────────────────────────────────────────────────

describe('buildPlist XML escaping', () => {
  test('escapes special chars in env value', () => {
    const opts: DaemonInstallOptions = {
      ...baseOpts,
      env: { DISPATCH_SERVERS: 'a&b<c>"d\'e' },
    };
    const xml = buildPlist(opts);
    expect(xml).toContain('a&amp;b&lt;c&gt;&quot;d&apos;e');
    // The raw chars must NOT appear inside the XML (after the DOCTYPE line)
    const bodyAfterDoctype = xml.split('?>').slice(1).join('?>');
    expect(bodyAfterDoctype).not.toContain('a&b');
  });

  test('escapes special chars in env key', () => {
    // Unusual but must not produce malformed XML
    const opts: DaemonInstallOptions = {
      ...baseOpts,
      env: { 'KEY&LT': 'value' },
    };
    const xml = buildPlist(opts);
    expect(xml).toContain('KEY&amp;LT');
    expect(xml).not.toContain('<key>KEY&LT</key>');
  });

  test('well-formed: no raw & < > in content outside DOCTYPE', () => {
    const opts: DaemonInstallOptions = {
      ...baseOpts,
      env: { DISPATCH_SERVERS: 'https://a.example.com?x=1&y=<2>' },
    };
    const xml = buildPlist(opts);
    // Strip the DOCTYPE declaration line which legitimately contains & and ;
    const lines = xml.split('\n').filter(l => !l.includes('DOCTYPE'));
    const body = lines.join('\n');
    // After stripping DOCTYPE, no bare & or < should remain except as entities
    expect(body).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(body).not.toContain('<2>'); // the raw < must be escaped
  });

  test('produces correct StandardOutPath and StandardErrorPath', () => {
    const xml = buildPlist(baseOpts);
    expect(xml).toContain('<string>/tmp/logs/dispatch.out.log</string>');
    expect(xml).toContain('<string>/tmp/logs/dispatch.err.log</string>');
  });
});

// ── status() PID parsing ─────────────────────────────────────────────────────

describe('createDarwinDaemon status()', () => {
  test('returns loaded=true and pid when the label is present with a PID', () => {
    // Sample launchctl list output: PID  exitcode  label
    const listOutput = [
      'PID\tStatus\tLabel',
      '12345\t0\tcom.apple.something',
      '67890\t0\tcom.dispatch.server',
      '-\t0\tcom.apple.other',
    ].join('\n');
    const run = vi.fn((_cmd: string, _args: string[]) => listOutput);
    const d = createDarwinDaemon(run);
    const s = d.status();
    expect(s.loaded).toBe(true);
    expect(s.pid).toBe(67890);
  });

  test('returns loaded=true and no pid when the process is loaded but not running (-)', () => {
    const listOutput = [
      'PID\tStatus\tLabel',
      '-\t0\tcom.dispatch.server',
    ].join('\n');
    const run = vi.fn((_cmd: string, _args: string[]) => listOutput);
    const d = createDarwinDaemon(run);
    const s = d.status();
    expect(s.loaded).toBe(true);
    expect(s.pid).toBeUndefined();
  });

  test('returns loaded=false when the label is absent', () => {
    const listOutput = [
      'PID\tStatus\tLabel',
      '123\t0\tcom.apple.something',
      '-\t0\tcom.apple.other',
    ].join('\n');
    const run = vi.fn((_cmd: string, _args: string[]) => listOutput);
    const d = createDarwinDaemon(run);
    const s = d.status();
    expect(s.loaded).toBe(false);
    expect(s.pid).toBeUndefined();
  });
});

// ── domain fallback (SSH vs local) ──────────────────────────────────────────

describe('createDarwinDaemon domain fallback', () => {
  vi.mock('fs', () => ({
    default: { mkdirSync: vi.fn(), writeFileSync: vi.fn(), rmSync: vi.fn() },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  }));

  test('start falls back to user/$uid when gui/$uid throws', () => {
    const calls: string[][] = [];
    const run = vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const target = args.find(a => a.includes('/'));
      if (target?.startsWith('gui/')) throw new Error('EIO');
      return '';
    });
    const d = createDarwinDaemon(run);
    d.start(); // should not throw
    const lastCall = calls[calls.length - 1];
    expect(lastCall.some(a => a.startsWith('user/'))).toBe(true);
  });

  test('stop falls back to user/$uid on EIO', () => {
    const calls: string[][] = [];
    const run = vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.some(a => a.startsWith('gui/'))) throw new Error('EIO');
      return '';
    });
    const d = createDarwinDaemon(run);
    expect(() => d.stop()).not.toThrow();
    expect(calls.some(c => c.some(a => a.startsWith('user/')))).toBe(true);
  });
});

// ── install() idempotency + uninstall plist cleanup ─────────────────────────

describe('createDarwinDaemon install()', () => {
  test('issues bootout BEFORE bootstrap when label is loaded', () => {
    const calls: string[][] = [];
    let listCallCount = 0;
    const run = vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'list') {
        listCallCount++;
        // First call (check after bootout): still loaded; second call: gone; final verify: loaded
        if (listCallCount === 1) return 'PID\tStatus\tLabel\n123\t0\tcom.dispatch.server\n';
        if (listCallCount === 2) return 'PID\tStatus\tLabel\n'; // gone
        return 'PID\tStatus\tLabel\n456\t0\tcom.dispatch.server\n'; // loaded after bootstrap
      }
      return ''; // bootout, bootstrap succeed silently
    });
    const sleeper = vi.fn();
    const d = createDarwinDaemon(run, sleeper, '/tmp/test.plist');
    d.install({ port: 3456, nodePath: '/usr/bin/node', entry: '/repo/server.js', repoRoot: '/repo', logDir: '/tmp/logs', env: {} });
    // bootout must come before bootstrap
    const bootoutIdx = calls.findIndex(c => c[1] === 'bootout');
    const bootstrapIdx = calls.findIndex(c => c[1] === 'bootstrap');
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);
  });

  test('retries bootstrap on EIO then succeeds', () => {
    let bootstrapAttempts = 0;
    let listCallCount = 0;
    const run = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'list') {
        listCallCount++;
        // After bootout polls: show gone; after bootstrap: show loaded
        if (listCallCount <= 1) return 'PID\tStatus\tLabel\n'; // gone after bootout
        return 'PID\tStatus\tLabel\n789\t0\tcom.dispatch.server\n';
      }
      if (args[0] === 'bootstrap') {
        bootstrapAttempts++;
        if (bootstrapAttempts < 2) throw new Error('EIO: bootstrap failed');
        return '';
      }
      return ''; // bootout
    });
    const sleeper = vi.fn();
    const d = createDarwinDaemon(run, sleeper, '/tmp/test.plist');
    expect(() => d.install({ port: 3456, nodePath: '/usr/bin/node', entry: '/repo/server.js', repoRoot: '/repo', logDir: '/tmp/logs', env: {} })).not.toThrow();
    expect(bootstrapAttempts).toBeGreaterThanOrEqual(2);
  });

  test('throws if label never loads after bootstrap attempts', () => {
    let listCallCount = 0;
    const run = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'list') {
        listCallCount++;
        return 'PID\tStatus\tLabel\n'; // never shows com.dispatch.server
      }
      // bootstrap always throws
      if (args[0] === 'bootstrap') throw new Error('EIO');
      return '';
    });
    const sleeper = vi.fn();
    const d = createDarwinDaemon(run, sleeper, '/tmp/test.plist');
    expect(() => d.install({ port: 3456, nodePath: '/usr/bin/node', entry: '/repo/server.js', repoRoot: '/repo', logDir: '/tmp/logs', env: {} })).toThrow(/failed to load/i);
  });

  test('uninstall calls rmSync on plist path', () => {
    const run = vi.fn(() => '');
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});
    const d = createDarwinDaemon(run, undefined, '/tmp/dispatch-test.plist');
    d.uninstall();
    expect(rmSpy).toHaveBeenCalledWith('/tmp/dispatch-test.plist', { force: true });
    rmSpy.mockRestore();
  });

  test('idempotency bootout calls pass { quiet: true }', () => {
    // Record the opts passed to each call so we can assert the two bootout
    // calls are issued with quiet:true (stderr suppressed).
    const callOpts: Array<RunnerOpts | undefined> = [];
    let listCallCount = 0;
    const run = vi.fn((cmd: string, args: string[], opts?: RunnerOpts) => {
      if (args[0] === 'list') {
        listCallCount++;
        if (listCallCount <= 1) return 'PID\tStatus\tLabel\n';
        return 'PID\tStatus\tLabel\n789\t0\tcom.dispatch.server\n';
      }
      if (args[0] === 'bootout') callOpts.push(opts);
      return '';
    });
    const d = createDarwinDaemon(run, vi.fn(), '/tmp/test.plist');
    d.install({ port: 3456, nodePath: '/usr/bin/node', entry: '/repo/server.js', repoRoot: '/repo', logDir: '/tmp/logs', env: {} });
    // The first two bootout calls (gui/ and user/) must both carry quiet:true.
    expect(callOpts.length).toBeGreaterThanOrEqual(2);
    expect(callOpts[0]).toEqual({ quiet: true });
    expect(callOpts[1]).toEqual({ quiet: true });
  });
});
