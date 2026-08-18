import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { installBrowserShim, withShimPath, TERMINAL_ID_ENV_VAR } from '../../src/auth/shim.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('installBrowserShim', () => {
  it('creates an executable dispatch-open shim and returns browser env', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-'));
    process.env.PATH = '/usr/local/bin:/usr/bin';

    const env = installBrowserShim({ dataDir, serverUrl: 'http://127.0.0.1:3456' });

    const binDir = path.join(dataDir, 'bin');
    const shimPath = path.join(binDir, 'dispatch-open');
    const script = fs.readFileSync(shimPath, 'utf8');
    const mode = fs.statSync(shimPath).mode & 0o777;

    expect(mode).toBe(0o755);
    expect(env).toEqual({
      BROWSER: 'dispatch-open',
      GH_BROWSER: 'dispatch-open',
      DISPATCH_SERVER_URL: 'http://127.0.0.1:3456',
      PATH: `${binDir}:/usr/local/bin:/usr/bin`,
    });
    expect(script).toContain('${DISPATCH_SERVER_URL}/api/auth-requests');
    expect(script).toContain('browser-env');
    expect(script).toContain('cwd');
    expect(script).toContain('curl');
    expect(script).toMatch(/\|\|\s*true/);
  });

  it('posts auth request JSON when executed without node in PATH', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-curl-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cwd-'));
    const realCwd = fs.realpathSync(cwd);
    const postedUrlFile = path.join(dataDir, 'posted-url.txt');
    const postedDataFile = path.join(dataDir, 'posted-data.json');
    const fakeCurl = path.join(fakeBin, 'curl');

    fs.writeFileSync(fakeCurl, `#!/bin/sh
data=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data)
      shift
      data="$1"
      ;;
    http://*|https://*)
      printf '%s' "$1" > '${postedUrlFile}'
      ;;
  esac
  shift
done
printf '%s' "$data" > '${postedDataFile}'
exit 0
`);
    fs.chmodSync(fakeCurl, 0o755);

    installBrowserShim({ dataDir, serverUrl: 'http://127.0.0.1:3456' });

    execFileSync(path.join(dataDir, 'bin', 'dispatch-open'), ['https://example.com/oauth?client_id=abc'], {
      cwd,
      env: {
        PATH: fakeBin,
        DISPATCH_SERVER_URL: 'http://127.0.0.1:3456',
      },
    });

    expect(fs.readFileSync(postedUrlFile, 'utf8')).toBe('http://127.0.0.1:3456/api/auth-requests');
    expect(JSON.parse(fs.readFileSync(postedDataFile, 'utf8'))).toEqual({
      url: 'https://example.com/oauth?client_id=abc',
      source: 'browser-env',
      cwd: realCwd,
    });
  });

  it('includes terminalId in the posted JSON when DISPATCH_TERMINAL_ID is set', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-curl-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cwd-'));
    const postedDataFile = path.join(dataDir, 'posted-data.json');
    const fakeCurl = path.join(fakeBin, 'curl');

    fs.writeFileSync(fakeCurl, `#!/bin/sh
data=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data)
      shift
      data="$1"
      ;;
  esac
  shift
done
printf '%s' "$data" > '${postedDataFile}'
exit 0
`);
    fs.chmodSync(fakeCurl, 0o755);

    installBrowserShim({ dataDir, serverUrl: 'http://127.0.0.1:3456' });

    execFileSync(path.join(dataDir, 'bin', 'dispatch-open'), ['https://example.com/oauth'], {
      cwd,
      env: {
        PATH: fakeBin,
        DISPATCH_SERVER_URL: 'http://127.0.0.1:3456',
        [TERMINAL_ID_ENV_VAR]: 'term-abc123',
      },
    });

    expect(JSON.parse(fs.readFileSync(postedDataFile, 'utf8')).terminalId).toBe('term-abc123');
  });

  it('omits terminalId when DISPATCH_TERMINAL_ID is unset', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-'));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-curl-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cwd-'));
    const postedDataFile = path.join(dataDir, 'posted-data.json');
    const fakeCurl = path.join(fakeBin, 'curl');

    fs.writeFileSync(fakeCurl, `#!/bin/sh
data=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data)
      shift
      data="$1"
      ;;
  esac
  shift
done
printf '%s' "$data" > '${postedDataFile}'
exit 0
`);
    fs.chmodSync(fakeCurl, 0o755);

    installBrowserShim({ dataDir, serverUrl: 'http://127.0.0.1:3456' });

    execFileSync(path.join(dataDir, 'bin', 'dispatch-open'), ['https://example.com/oauth'], {
      cwd,
      env: { PATH: fakeBin, DISPATCH_SERVER_URL: 'http://127.0.0.1:3456' },
    });

    expect(JSON.parse(fs.readFileSync(postedDataFile, 'utf8'))).not.toHaveProperty('terminalId');
  });
});

describe('system-opener shims', () => {
  it('shadows `open` on macOS so a CLI that ignores $BROWSER is still caught', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-open-'));
    installBrowserShim({ dataDir: dir, serverUrl: 'http://127.0.0.1:3456' });
    const shim = path.join(dir, 'bin', 'open');
    // Only where a real `open` exists — that is what it is standing in for.
    if (!fs.existsSync('/usr/bin/open')) return;
    expect(fs.existsSync(shim)).toBe(true);
    expect(fs.statSync(shim).mode & 0o111).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('always shadows xdg-open, which has no fixed path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-xdg-'));
    installBrowserShim({ dataDir: dir, serverUrl: 'http://127.0.0.1:3456' });
    expect(fs.existsSync(path.join(dir, 'bin', 'xdg-open'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('relays a URL passed to the `open` shim', () => {
    if (!fs.existsSync('/usr/bin/open')) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-relay-'));
    const log = path.join(dir, 'posted.txt');
    installBrowserShim({ dataDir: dir, serverUrl: 'http://127.0.0.1:59999' });

    // Stand in for curl so nothing leaves the machine: a fake curl that records its argv.
    const fakeBin = path.join(dir, 'fake');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    fs.chmodSync(path.join(fakeBin, 'curl'), 0o755);

    execFileSync(path.join(dir, 'bin', 'open'), ['https://accounts.x.ai/sign-in?code=1'], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, DISPATCH_SERVER_URL: 'http://127.0.0.1:59999' },
    });

    const posted = fs.readFileSync(log, 'utf-8');
    expect(posted).toContain('/api/auth-requests');
    expect(posted).toContain('accounts.x.ai/sign-in');
    expect(posted).toContain('system-opener');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passes a non-URL straight through to the real opener — `open .` must still work', () => {
    if (!fs.existsSync('/usr/bin/open')) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-passthru-'));
    const log = path.join(dir, 'delegated.txt');
    installBrowserShim({ dataDir: dir, serverUrl: 'http://127.0.0.1:59999' });

    // Rewrite the shim to point at a recorder instead of the real /usr/bin/open, so the
    // test proves delegation without actually launching anything.
    const shimPath = path.join(dir, 'bin', 'open');
    const recorder = path.join(dir, 'recorder');
    fs.writeFileSync(recorder, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    fs.chmodSync(recorder, 0o755);
    fs.writeFileSync(shimPath, fs.readFileSync(shimPath, 'utf-8').replace("'/usr/bin/open'", JSON.stringify(recorder)), { mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);

    execFileSync(shimPath, ['-a', 'Xcode', '/tmp/thing.swift'], {
      env: { ...process.env, DISPATCH_SERVER_URL: 'http://127.0.0.1:59999' },
    });

    expect(fs.readFileSync(log, 'utf-8').trim()).toBe('-a Xcode /tmp/thing.swift');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('withShimPath — the clobber that killed the whole relay', () => {
  it('puts the shim bin dir first when another contributor rebuilt PATH', () => {
    const merged = withShimPath('/data', '/data/tools/bin:/usr/bin:/bin');
    expect(merged.split(':')[0]).toBe(path.join('/data', 'bin'));
    // and keeps everyone else's entries, in order
    expect(merged).toBe([path.join('/data', 'bin'), '/data/tools/bin', '/usr/bin', '/bin'].join(':'));
  });

  it('does not duplicate the dir when it is already present', () => {
    const dir = path.join('/data', 'bin');
    const merged = withShimPath('/data', `${dir}:/usr/bin`);
    expect(merged.split(':').filter((p) => p === dir)).toHaveLength(1);
  });

  it('copes with an empty or missing PATH', () => {
    expect(withShimPath('/data', '')).toBe(path.join('/data', 'bin'));
    expect(withShimPath('/data', undefined)).toBe(path.join('/data', 'bin'));
  });

  it('makes dispatch-open reachable by the name $BROWSER points at', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-path-'));
    const env = installBrowserShim({ dataDir: dir, serverUrl: 'http://127.0.0.1:3456' });
    // Simulate the real merge: the tools env overwrites PATH, dropping the shim prefix.
    const clobbered = `${dir}/tools/bin:/usr/bin:/bin`;
    const repaired = withShimPath(dir, clobbered);
    const found = repaired.split(':').some((d) => fs.existsSync(path.join(d, env.BROWSER)));
    expect(found).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
