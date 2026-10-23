import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand } from '../src/index.js';

// A small in-memory stand-in for dispatch-server/access, so the CLI test needs no built daemon.
function fakeAccess() {
  let token = 'tok-1';
  const hosts: string[] = [];
  return {
    ensureAccessToken: vi.fn(() => token),
    rotateAccessToken: vi.fn(() => (token = 'tok-2')),
    createAccessConfig: vi.fn(() => ({
      allowedHosts: () => hosts, allowedOrigins: () => [],
      addHost: (n: string) => { hosts.push(n.toLowerCase()); },
      removeHost: (n: string) => { hosts.splice(hosts.indexOf(n.toLowerCase()), 1); },
    })),
  };
}

let out: string[];
let dataDir: string;
beforeEach(() => {
  out = [];
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-access-'));
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const run = (args: string[], access = fakeAccess()) =>
  Promise.resolve(runCommand(['access', ...args], { daemon: {} as any, port: 3456, dataDir, accessLib: access } as any)).then(() => access);

describe('dispatch access', () => {
  test('prints the token and the sign-in steps', async () => {
    await run([]);
    const text = out.join('\n');
    expect(text).toContain('tok-1');
    expect(text).toMatch(/sign-in page/i);
    expect(text).toContain('3456');
  });
  test('--link HOST prints a fragment link and nothing else secret-looking beyond the token', async () => {
    await run(['--link', 'mac.tail1.ts.net']);
    expect(out.join('\n')).toContain('http://mac.tail1.ts.net:3456/#access=tok-1');
  });
  test('--link accepts a full URL (tailscale serve has no port)', async () => {
    await run(['--link', 'https://mac.tail1.ts.net/']);
    expect(out.join('\n')).toContain('https://mac.tail1.ts.net/#access=tok-1');
  });
  test('rotate writes a new token and says every browser signs out', async () => {
    const a = await run(['rotate']);
    expect(a.rotateAccessToken).toHaveBeenCalledWith(dataDir);
    expect(out.join('\n')).toMatch(/signed out/i);
  });
  test('allow-host, list-hosts and remove-host', async () => {
    const a = fakeAccess();
    await run(['allow-host', 'Proxy.Example.com'], a);
    await run(['list-hosts'], a);
    expect(out.join('\n')).toContain('proxy.example.com');
    await run(['remove-host', 'proxy.example.com'], a);
    out.length = 0;
    await run(['list-hosts'], a);
    expect(out.join('\n')).not.toContain('proxy.example.com');
  });
  test('missing host name is a usage error', async () => {
    await expect(run(['allow-host'])).rejects.toThrow(/usage/);
  });
  test('without a data dir it refuses', async () => {
    await expect(Promise.resolve(runCommand(['access'], { daemon: {} as any, port: 1, accessLib: fakeAccess() } as any))).rejects.toThrow(/data/i);
  });
});

describe('dispatch status', () => {
  test('prints the network line, never a token', () => {
    const daemon = { status: () => ({ loaded: true, pid: 1 }) } as any;
    runCommand(['status'], { daemon, port: 3456, probe: () => true, dataDir } as any);
    const text = out.join('\n');
    expect(text).toContain('Network: other devices need the access token');
    expect(text).not.toContain('tok-');
  });
});
