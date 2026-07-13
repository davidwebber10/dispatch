import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { installBrowserShim, TERMINAL_ID_ENV_VAR } from '../../src/auth/shim.js';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

// The browser shim is a #!/bin/sh POSIX script — the whole suite is unix-only.
// On Windows, platform.installBrowserShim is a no-op by design.
describe.skipIf(process.platform === 'win32')('installBrowserShim', () => {
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
