import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked here and ONLY here — this file never imports createApp, so faking child_process
// cannot disturb the server's own boot-time shell-outs.
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null) => void) => cb(null)),
}));

import { execFile } from 'child_process';
import {
  isLoopbackAddress,
  isLoopbackHost,
  canReveal,
  revealClientFrom,
  revealInFinder,
  type RevealClient,
} from '../../src/files/reveal.js';

/** A legitimate local browser: loopback socket, loopback Host, no proxy headers. */
function localClient(over: Partial<RevealClient> = {}): RevealClient {
  return { remoteAddress: '127.0.0.1', host: 'localhost:3456', proxied: false, ...over };
}

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

describe('isLoopbackHost', () => {
  it.each([
    ['localhost:3456', true],
    ['127.0.0.1:3456', true],
    ['[::1]:3456', true],
    ['localhost', true],
    ['LOCALHOST:3456', true],          // Host is case-insensitive
    ['127.0.0.1', true],
    ['dispatch.example.com', false],   // the Cloudflare tunnel hostname
    ['mymac.ts.net:3456', false],      // `tailscale serve` in front of the daemon
    ['evil-localhost.com', false],     // suffix/prefix games must not pass
    ['localhost.evil.com', false],
    ['', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it('is false for undefined', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('canReveal', () => {
  it('allows the genuinely local browser: loopback socket AND loopback Host, unproxied', () => {
    expect(canReveal(localClient(), 'darwin')).toBe(true);
  });

  it('THE TUNNEL CASE: refuses a loopback socket whose Host is a public hostname', () => {
    // cloudflared/`tailscale serve` run ON THIS MAC and dial http://localhost:3456, so the
    // daemon sees a genuine 127.0.0.1 peer for every remote visitor. Only the Host header
    // (what the BROWSER dialed) distinguishes them.
    expect(canReveal(localClient({ host: 'dispatch.example.com' }), 'darwin')).toBe(false);
  });

  it('refuses a proxied request even when both the socket and the Host look local', () => {
    // Cloudflare always sets cf-connecting-ip; this is the belt-and-braces check for a proxy
    // configured with httpHostHeader: localhost:3456.
    expect(canReveal(localClient({ proxied: true }), 'darwin')).toBe(false);
  });

  it('refuses a remote client connecting directly (Tailscale IP on the socket)', () => {
    expect(canReveal(localClient({ remoteAddress: '100.83.12.4', host: 'mymac.ts.net:3456' }), 'darwin')).toBe(false);
  });

  it('refuses loopback on a non-macOS host (no Finder)', () => {
    expect(canReveal(localClient(), 'linux')).toBe(false);
  });

  it('refuses when the Host header is missing entirely', () => {
    expect(canReveal(localClient({ host: undefined }), 'darwin')).toBe(false);
  });
});

describe('revealClientFrom', () => {
  it('reads the socket peer address and the Host header, and flags no proxy for a clean request', () => {
    expect(revealClientFrom({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3456' },
    })).toEqual({ remoteAddress: '127.0.0.1', host: 'localhost:3456', proxied: false });
  });

  it.each(['x-forwarded-for', 'forwarded', 'cf-connecting-ip'])('flags %s as proxied', (header) => {
    const client = revealClientFrom({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3456', [header]: '8.8.8.8' },
    });
    expect(client.proxied).toBe(true);
    expect(canReveal(client, 'darwin')).toBe(false);
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
    // Absolute path, not a PATH lookup: the daemon runs under launchd with a minimal environment.
    expect(cmd).toBe('/usr/bin/open');
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
