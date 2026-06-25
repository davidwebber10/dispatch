import { describe, expect, test, vi } from 'vitest';
import { buildPlist, esc, createDarwinDaemon } from '../../src/platform/daemon-darwin.js';
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

// ── domain fallback (SSH vs local) ──────────────────────────────────────────

describe('createDarwinDaemon domain fallback', () => {
  vi.mock('fs', () => ({
    default: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
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
