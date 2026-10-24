import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFile, execFileSync } from 'child_process';
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
    expect(script).toContain('browser-env');
    expect(script).not.toContain('curl');
    expect(script).toContain('shim-relay.js');
    expect(script).toMatch(/\|\|\s*true/);
  });

  it('runs the relay with the URL and the source as the only arguments', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-cwd-'));
    const argvFile = path.join(dataDir, 'argv.json');
    const fakeRelay = path.join(dataDir, 'fake-relay.mjs');
    fs.writeFileSync(fakeRelay, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`);

    installBrowserShim({ dataDir, serverUrl: 'http://127.0.0.1:3456', relayPath: fakeRelay });
    // No node and no curl on PATH: the shim must use the absolute node path and never curl.
    execFileSync(path.join(dataDir, 'bin', 'dispatch-open'), ['https://example.com/oauth?client_id=abc'], {
      cwd,
      env: { PATH: '/nonexistent', DISPATCH_SERVER_URL: 'http://127.0.0.1:3456', DISPATCH_AUTH: `dsk_${'K'.repeat(43)}` },
    });
    expect(JSON.parse(fs.readFileSync(argvFile, 'utf8'))).toEqual(['https://example.com/oauth?client_id=abc', 'browser-env']);
  });

  it('never puts the key in the relay argv or in the script', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shim-'));
    installBrowserShim({ dataDir, serverUrl: 'http://127.0.0.1:3456' });
    for (const f of ['dispatch-open', 'open', 'xdg-open']) {
      const p = path.join(dataDir, 'bin', f);
      if (!fs.existsSync(p)) continue;
      const script = fs.readFileSync(p, 'utf8');
      expect(script).not.toContain('curl');
      expect(script).not.toContain('DISPATCH_AUTH');
      expect(script).toContain('shim-relay.js');
    }
  });
});

describe('shim relay', () => {
  const root = path.resolve(__dirname, '../..');
  const relayTs = path.join(root, 'src/auth/shim-relay.ts');
  const runRelay = (args: string[], env: Record<string, string>, cwd: string) =>
    new Promise<void>((resolve) => {
      execFile(process.execPath, ['--import', 'tsx', relayTs, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env, PWD: cwd } }, () => resolve());
    });
  async function withServer<T>(fn: (url: string, got: Array<{ url: string; auth?: string; body: any }>) => Promise<T>): Promise<T> {
    const got: Array<{ url: string; auth?: string; body: any }> = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        got.push({ url: req.url ?? '', auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
        res.statusCode = 204; res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try { return await fn(`http://127.0.0.1:${port}`, got); } finally { server.close(); }
  }
  const KEY = `dtk_${'R'.repeat(43)}`;

  it('posts the header from DISPATCH_AUTH and the terminalId to DISPATCH_API', async () => {
    await withServer(async (base, got) => {
      await runRelay(['https://example.com/oauth', 'browser-env'], { DISPATCH_API: base, DISPATCH_SERVER_URL: 'http://127.0.0.1:1', DISPATCH_AUTH: KEY, DISPATCH_TERMINAL_ID: 'term-1' }, '/tmp');
      expect(got).toHaveLength(1);
      expect(got[0].url).toBe('/api/auth-requests');
      expect(got[0].auth).toBe(`Bearer ${KEY}`);
      expect(got[0].body).toMatchObject({ url: 'https://example.com/oauth', source: 'browser-env', terminalId: 'term-1' });
    });
  });

  it('falls back to DISPATCH_SERVER_URL with no header when DISPATCH_API is unset', async () => {
    await withServer(async (base, got) => {
      await runRelay(['https://example.com/a', 'system-opener'], { DISPATCH_SERVER_URL: base, DISPATCH_AUTH: KEY }, '/tmp');
      expect(got).toHaveLength(1);
      expect(got[0].auth).toBeUndefined();
      expect(got[0].body).not.toHaveProperty('terminalId');
    });
  });

  it('sends no header when DISPATCH_API points elsewhere than the target', async () => {
    await withServer(async (base, got) => {
      await runRelay(['https://example.com/a', 'browser-env'], { DISPATCH_SERVER_URL: base, DISPATCH_API: 'http://127.0.0.1:1', DISPATCH_AUTH: KEY }, '/tmp');
      // The relay posts to DISPATCH_API first (dead), so nothing reaches the other server and no key leaves.
      expect(got.every((g) => g.auth === undefined)).toBe(true);
    });
  });

  it('sends no header without DISPATCH_AUTH', async () => {
    await withServer(async (base, got) => {
      await runRelay(['https://example.com/a', 'browser-env'], { DISPATCH_API: base }, '/tmp');
      expect(got).toHaveLength(1);
      expect(got[0].auth).toBeUndefined();
    });
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
    const fakeRelay = path.join(dir, 'fake-relay.mjs');
    fs.writeFileSync(fakeRelay, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
    installBrowserShim({ dataDir: dir, serverUrl: 'http://127.0.0.1:59999', relayPath: fakeRelay });

    execFileSync(path.join(dir, 'bin', 'open'), ['https://accounts.x.ai/sign-in?code=1'], {
      env: { ...process.env, DISPATCH_SERVER_URL: 'http://127.0.0.1:59999' },
    });

    const posted = fs.readFileSync(log, 'utf-8');
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
