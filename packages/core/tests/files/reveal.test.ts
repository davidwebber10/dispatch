import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked here and ONLY here — this file never imports createApp, so faking child_process
// cannot disturb the server's own boot-time shell-outs.
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => cb(null)),
}));

import { execFile } from 'child_process';
import { isLoopbackAddress, canReveal, revealInFinder } from '../../src/files/reveal.js';

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.53', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['192.168.1.20', false],
    ['100.83.12.4', false],   // Tailscale CGNAT — the Mac mini case
    ['::ffff:10.0.0.9', false],
    ['', false],
    // Regression: reject malformed addresses with trailing garbage
    ['127.0.0.1.evil.com', false],
    ['127.0.0.1x', false],
    // Regression: reject incomplete dotted quads and non-loopback 127.x ranges
    ['0.0.0.0', false],
    ['127.1', false],
  ])('%s -> %s', (addr, expected) => {
    expect(isLoopbackAddress(addr)).toBe(expected);
  });

  it('is false for undefined', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('canReveal', () => {
  it('allows loopback on macOS', () => {
    expect(canReveal('127.0.0.1', 'darwin')).toBe(true);
  });
  it('refuses a remote client even on macOS', () => {
    expect(canReveal('100.83.12.4', 'darwin')).toBe(false);
  });
  it('refuses loopback on a non-macOS host (no Finder)', () => {
    expect(canReveal('127.0.0.1', 'linux')).toBe(false);
  });
});

describe('revealInFinder', () => {
  beforeEach(() => {
    // Block body, not a concise arrow: `mockClear()` returns the mock itself (a function), and
    // Vitest treats a function *returned* from beforeEach as an auto-teardown it invokes with
    // zero args after the test — which would call our execFile impl with cb=undefined and throw.
    vi.mocked(execFile).mockClear();
  });

  it('passes every path as a separate argv entry, never a shell string', async () => {
    await revealInFinder(['/w/a.png', '/w/b.png']);
    const [cmd, args, opts] = vi.mocked(execFile).mock.calls[0];
    expect(cmd).toBe('open');
    expect(args).toEqual(['-R', '/w/a.png', '/w/b.png']);
    // Assert that shell is never enabled (hardened against injection if args parsing ever mutates)
    expect((opts as any).shell).toBeFalsy();
  });

  it('does not interpolate a hostile filename', async () => {
    await revealInFinder(['/w/$(rm -rf ~).png']);
    const [, args] = vi.mocked(execFile).mock.calls[0];
    expect(args).toEqual(['-R', '/w/$(rm -rf ~).png']); // inert: it is one argv element
  });

  it('rejects when open fails', async () => {
    vi.mocked(execFile).mockImplementationOnce(
      ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null) => void) => cb(new Error('boom'))) as never,
    );
    await expect(revealInFinder(['/w/a.png'])).rejects.toThrow('boom');
  });
});
