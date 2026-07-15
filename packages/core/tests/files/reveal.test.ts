import { describe, it, expect } from 'vitest';
import {
  isLoopbackAddress,
  isLoopbackHost,
  revealClientFrom,
} from '../../src/files/reveal.js';

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
  });
});
