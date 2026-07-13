import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process execFile BEFORE importing the module under test.
const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));
vi.mock('node:fs', () => ({ existsSync: (p: string) => fsExists(p) }));

// Mock the platform singleton so resolveCommand is controllable in tests.
const resolveCommandMock = vi.fn<(name: string) => string | null>();
vi.mock('../../src/platform/index.js', () => ({
  platform: { resolveCommand: (name: string) => resolveCommandMock(name) },
}));

let fsExists: (p: string) => boolean = () => false;

// promisify(execFile) appends the callback as the LAST arg, so calls arrive as
// (cmd, args, cb) for commands and (cmd, args, opts, cb) with options. Treat the
// last argument as the callback regardless of arity.
function whenExec(impl: (cmd: string, args: string[]) => { stdout: string } | Error) {
  execFileMock.mockImplementation((...allArgs: any[]) => {
    const cb = allArgs[allArgs.length - 1];
    const [cmd, args] = allArgs as [string, string[]];
    const r = impl(cmd, args);
    if (r instanceof Error) cb(r); else cb(null, { stdout: r.stdout, stderr: '' });
  });
}

import { detectProvider, detectTailscale } from '../../src/setup/detect.js';

// These cases rely on posix-style path matching in fsExists stubs (e.g. p.endsWith('/.claude'))
// and posix-only binary resolution — guard the whole suite on Windows.
describe.skipIf(process.platform === 'win32')('detectProvider', () => {
  beforeEach(() => { execFileMock.mockReset(); resolveCommandMock.mockReset(); fsExists = () => false; });

  it('reports not installed when the binary is absent', async () => {
    resolveCommandMock.mockReturnValue(null);
    whenExec(() => ({ stdout: '' }));
    const r = await detectProvider('claude');
    expect(r).toEqual({ name: 'claude', installed: false, signedIn: false });
  });

  it('reports installed + signedIn when binary and creds exist', async () => {
    fsExists = (p) => p.endsWith('/.claude') || p.endsWith('/.credentials.json');
    resolveCommandMock.mockReturnValue('/usr/local/bin/claude');
    whenExec((cmd, args) => {
      if (args.includes('--version')) return { stdout: 'claude 1.2.3\n' };
      return { stdout: '' };
    });
    const r = await detectProvider('claude');
    expect(r.installed).toBe(true);
    expect(r.version).toBe('claude 1.2.3');
    expect(r.signedIn).toBe(true);
  });

  it('signedIn is "unknown" when installed but no creds file', async () => {
    fsExists = (p) => p.endsWith('/.claude'); // dir exists, no creds file
    resolveCommandMock.mockReturnValue('/usr/local/bin/claude');
    whenExec(() => ({ stdout: '' }));
    const r = await detectProvider('claude');
    expect(r.signedIn).toBe('unknown');
  });
});

describe.skipIf(process.platform === 'win32')('detectTailscale', () => {
  beforeEach(() => { execFileMock.mockReset(); resolveCommandMock.mockReset(); fsExists = () => false; });

  it('not installed when binary missing and app bundle absent', async () => {
    resolveCommandMock.mockReturnValue(null);
    whenExec(() => ({ stdout: '' }));
    const r = await detectTailscale(3456);
    expect(r).toEqual({ installed: false, running: false });
  });

  it('builds the URL from MagicDNS when running', async () => {
    resolveCommandMock.mockReturnValue('/usr/bin/tailscale');
    whenExec((cmd, args) => {
      if (args.includes('status')) return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'my-mac.tailnet.ts.net.' } }) };
      return { stdout: '' };
    });
    const r = await detectTailscale(3456);
    expect(r).toEqual({ installed: true, running: true, dnsName: 'my-mac.tailnet.ts.net', url: 'http://my-mac.tailnet.ts.net:3456' });
  });

  it('running:false (no url) when stopped', async () => {
    resolveCommandMock.mockReturnValue('/usr/bin/tailscale');
    whenExec((cmd, args) => {
      if (args.includes('status')) return { stdout: JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } }) };
      return { stdout: '' };
    });
    const r = await detectTailscale(3456);
    expect(r.installed).toBe(true);
    expect(r.running).toBe(false);
    expect(r.url).toBeUndefined();
  });
});
