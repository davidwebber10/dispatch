import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCommand } from '../src/index.js';

// A small in-memory stand-in for dispatch-server/access, so the CLI test needs no built daemon.
function fakeAccess() {
  let token = 'tok-1';
  const hosts: string[] = [];
  let cf: { teamDomain: string; aud: string } | null = null;
  return {
    ensureAccessToken: vi.fn(() => token),
    rotateAccessToken: vi.fn(() => (token = 'tok-2')),
    createAccessConfig: vi.fn(() => ({
      allowedHosts: () => hosts, allowedOrigins: () => [],
      addHost: (n: string) => { hosts.push(n.toLowerCase()); },
      removeHost: (n: string) => { hosts.splice(hosts.indexOf(n.toLowerCase()), 1); },
      cloudflareAccess: () => cf,
      setCloudflareAccess: (v: { teamDomain: string; aud: string } | null) => {
        if (v && !v.teamDomain.endsWith('.cloudflareaccess.com')) throw new Error('not a team domain: it has the form <name>.cloudflareaccess.com');
        cf = v;
      },
    })),
  };
}

let out: string[];
let dataDir: string;
beforeEach(() => {
  out = [];
  // The test may run inside a Dispatch thread: start from a clean thread environment.
  for (const n of ['DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_TERMINAL_ID', 'DISPATCH_TERMINAL', 'DISPATCH_API']) vi.stubEnv(n, '');
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-access-'));
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dataDir, { recursive: true, force: true }); });

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
  test.each([
    ['192.168.4.60:3490', 'http://192.168.4.60:3490/#access=tok-1'],
    ['192.168.4.60', 'http://192.168.4.60:3456/#access=tok-1'],
    ['mac.tail1.ts.net:8080', 'http://mac.tail1.ts.net:8080/#access=tok-1'],
    ['[::1]:3490', 'http://[::1]:3490/#access=tok-1'],
    ['[::1]', 'http://[::1]:3456/#access=tok-1'],
    ['https://mac.ts.net/#old', 'https://mac.ts.net/#access=tok-1'],
    ['HTTPS://mac.ts.net', 'https://mac.ts.net/#access=tok-1'],
    ['https://mac.ts.net/dispatch/', 'https://mac.ts.net/dispatch/#access=tok-1'],
    ['mac.ts.net/', 'http://mac.ts.net:3456/#access=tok-1'],
    ['  192.168.4.60:3490 ', 'http://192.168.4.60:3490/#access=tok-1'],
    ['fd7a:115c:a1e0::1', 'http://[fd7a:115c:a1e0::1]:3456/#access=tok-1'],
  ])('--link %s does not add a second port', async (host, want) => {
    await run(['--link', host]);
    expect(out.join('\n')).toBe(want);
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

// W1-C: the Cloudflare Access check.
describe('dispatch access cloudflare', () => {
  const AUD = 'a'.repeat(64);
  test('--team-domain and --aud turn the check on and say so', async () => {
    const a = fakeAccess();
    await run(['allow-host', 'dispatch.example.com'], a);
    out.length = 0;
    await run(['cloudflare', '--team-domain', 'acme.cloudflareaccess.com', '--aud', AUD], a);
    expect(a.createAccessConfig.mock.results.at(-1)!.value.cloudflareAccess()).toEqual({ teamDomain: 'acme.cloudflareaccess.com', aud: AUD });
    const text = out.join('\n');
    expect(text).toContain('Cloudflare Access check: on (team acme.cloudflareaccess.com)');
    expect(text).toMatch(/sign-in page/);
    expect(text).not.toMatch(/No host is allow-listed/);
  });
  test('the flags can come in either order, and no allow-listed host gives one advice line', async () => {
    const a = await run(['cloudflare', '--aud', AUD, '--team-domain', 'acme.cloudflareaccess.com']);
    expect(a.createAccessConfig.mock.results.at(-1)!.value.cloudflareAccess()).toEqual({ teamDomain: 'acme.cloudflareaccess.com', aud: AUD });
    expect(out.join('\n')).toMatch(/No host is allow-listed/);
  });
  test('--off turns the check off', async () => {
    const a = fakeAccess();
    await run(['cloudflare', '--team-domain', 'acme.cloudflareaccess.com', '--aud', AUD], a);
    out.length = 0;
    await run(['cloudflare', '--off'], a);
    expect(a.createAccessConfig.mock.results.at(-1)!.value.cloudflareAccess()).toBeNull();
    expect(out.join('\n')).toContain('Cloudflare Access check: off');
  });
  test('with no flag it prints the state and changes nothing', async () => {
    const a = fakeAccess();
    await run(['cloudflare'], a);
    expect(out.join('\n')).toContain('Cloudflare Access check: off');
    await run(['cloudflare', '--team-domain', 'acme.cloudflareaccess.com', '--aud', AUD], a);
    out.length = 0;
    await run(['cloudflare'], a);
    expect(out.join('\n')).toContain('Cloudflare Access check: on (team acme.cloudflareaccess.com)');
  });
  test('one value without the other, an unknown flag and --off with a value are usage errors', async () => {
    await expect(run(['cloudflare', '--team-domain', 'acme.cloudflareaccess.com'])).rejects.toThrow(/usage: dispatch access cloudflare/);
    await expect(run(['cloudflare', '--aud', AUD])).rejects.toThrow(/usage/);
    await expect(run(['cloudflare', '--team-domain', '--aud', AUD])).rejects.toThrow(/usage/);
    await expect(run(['cloudflare', '--on'])).rejects.toThrow(/usage/);
    await expect(run(['cloudflare', '--off', '--aud', AUD])).rejects.toThrow(/usage/);
  });
  test('a value that is not a team domain is refused with the reason, and nothing is saved', async () => {
    const a = fakeAccess();
    await expect(run(['cloudflare', '--team-domain', 'acme.example.com', '--aud', AUD], a)).rejects.toThrow(/team domain/);
    expect(a.createAccessConfig.mock.results.at(-1)!.value.cloudflareAccess()).toBeNull();
  });
  test('refuses inside a Dispatch thread', async () => {
    vi.stubEnv('DISPATCH_TERMINAL_ID', 't1');
    vi.stubEnv('DISPATCH_AUTH', 'dtk_thread_key_for_the_test');
    vi.stubEnv('DISPATCH_API', 'http://localhost:3456');
    await expect(run(['cloudflare', '--off'])).rejects.toThrow(/not in a Dispatch thread/);
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

  // W1-C. `status` reads access.json itself: it is synchronous and never loads the daemon's code.
  const status = () => {
    out.length = 0;
    runCommand(['status'], { daemon: { status: () => ({ loaded: true, pid: 1 }) } as any, port: 3456, probe: () => false, dataDir } as any);
    return out.join('\n');
  };
  const writeAccess = (v: unknown) => fs.writeFileSync(path.join(dataDir, 'access.json'), JSON.stringify(v));

  test('Cloudflare Access check: off, with no advice while no host is allow-listed', () => {
    expect(status()).toContain('Cloudflare Access check: off');
    expect(status()).not.toMatch(/Advice/);
    writeAccess({ allowedHosts: [] });
    expect(status()).not.toMatch(/Advice/);
  });
  test('off with an allow-listed host: one advice line', () => {
    writeAccess({ allowedHosts: ['dispatch.example.com'] });
    const text = status();
    expect(text).toContain('Cloudflare Access check: off');
    expect(text.split('\n').filter((l) => /^Advice:/.test(l))).toHaveLength(1);
    expect(text).toMatch(/Advice: .*dispatch access cloudflare --team-domain/);
  });
  test('on: the team is named, the aud is not, and there is no advice', () => {
    writeAccess({ allowedHosts: ['dispatch.example.com'], cloudflareAccess: { teamDomain: 'acme.cloudflareaccess.com', aud: 'a'.repeat(64) } });
    const text = status();
    expect(text).toContain('Cloudflare Access check: on (team acme.cloudflareaccess.com)');
    expect(text).not.toContain('a'.repeat(64));
    expect(text).not.toMatch(/Advice/);
  });
  test('a saved value that is not valid is reported, not hidden', () => {
    writeAccess({ allowedHosts: ['dispatch.example.com'], cloudflareAccess: { teamDomain: 'typo' } });
    expect(status()).toMatch(/Cloudflare Access check: on \(the saved value is not valid/);
  });
  test('with no data directory the line is left out', () => {
    out.length = 0;
    runCommand(['status'], { daemon: { status: () => ({ loaded: true, pid: 1 }) } as any, port: 3456, probe: () => false } as any);
    expect(out.join('\n')).not.toMatch(/Cloudflare Access/);
  });
});
